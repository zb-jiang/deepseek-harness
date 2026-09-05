package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import org.flowable.engine.TaskService;
import org.flowable.task.api.Task;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * DSH 任务薄封装 REST 端点(参见 Flowable 自带 REST 之上补的薄封装)。
 *
 * <p>设计取舍:Flowable 自带 REST 在 {@code /process-api/runtime/tasks/*} 提供 CRUD,
 * 但返回字段是 Flowable 原生模型,不含 dsh_node_meta 等业务字段。本端点负责拼装
 * Flowable 任务 + task-local 变量(DshExtensionProperties JSON)为业务 DTO,供
 * DSH enterprise profile 的 task-api 直接消费。
 *
 * <p>覆盖范围:
 * <ul>
 *   <li>{@code GET /dsh/tasks/my-tasks}:查当前 JWT 用户已认领的任务(assignee = sub)。</li>
 *   <li>{@code GET /dsh/tasks/{taskId}}:查单个任务详情,含 dsh 元数据。</li>
 *   <li>{@code POST /dsh/tasks/{taskId}/complete}:员工端提交已映射好的流程上下文
 *       变量 Map,后端按声明类型转换后写入并 complete 任务(design 2026-09-01 §6)。</li>
 * </ul>
 *
 * <p>未覆盖的能力(直接用 Flowable 自带 REST):
 * <ul>
 *   <li>候选任务查询(按 candidateGroup/角色继承展开):DSH task-api 自行实现,
 *       调 {@code /process-api/runtime/tasks?candidateGroup=...}。</li>
 *   <li>任务认领/转交:直接调 {@code /process-api/runtime/tasks/{taskId}}。</li>
 * </ul>
 */
@RestController
@RequestMapping("/dsh/tasks")
public class DshTaskController {

    private final TaskService taskService;
    private final ObjectMapper objectMapper;
    private final DshTaskCompletionService completionService;
    private final DshTaskMetaService taskMetaService;

    public DshTaskController(TaskService taskService,
                              ObjectMapper objectMapper,
                              DshTaskCompletionService completionService,
                              DshTaskMetaService taskMetaService) {
        this.taskService = taskService;
        this.objectMapper = objectMapper;
        this.completionService = completionService;
        this.taskMetaService = taskMetaService;
    }

    /**
     * 查询当前 JWT 用户已认领的任务(assignee = sub)。
     *
     * <p>不含候选任务(未认领);候选任务由 task-api 按角色集查 candidateGroup 拿。
     * 用 {@code includeTaskLocalVariables} 一次查全部 local 变量,避免 N+1;
     * 流程名/发起人由 {@link DshTaskMetaService#enrichByInstance} 批量补齐。
     */
    @GetMapping("/my-tasks")
    public List<TaskDto> getMyTasks(@AuthenticationPrincipal Jwt jwt) {
        String userId = jwt.getSubject();
        List<Task> tasks = taskService.createTaskQuery()
            .taskAssignee(userId)
            .includeTaskLocalVariables()
            .orderByTaskCreateTime().desc()
            .list();
        Map<String, DshTaskMetaService.TaskMeta> metaByInstance = taskMetaService.enrichByInstance(tasks);
        return tasks.stream()
            .map(task -> toDto(task, metaByInstance.get(task.getProcessInstanceId())))
            .toList();
    }

    /**
     * 查询单个任务详情,含 dsh 元数据。
     *
     * <p>不校验任务归属(任何已认证用户都能查);V1 单企业内部信任,可接受。
     * V2 可加 assignee/candidate 校验。
     */
    @GetMapping("/{taskId}")
    public TaskDto getTask(@PathVariable String taskId, @AuthenticationPrincipal Jwt jwt) {
        Task task = taskService.createTaskQuery()
            .taskId(taskId)
            .includeTaskLocalVariables()
            .singleResult();
        if (task == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Task not found: " + taskId);
        }
        return toDto(task, taskMetaService.enrich(task));
    }

    /**
     * 员工提交已映射好的流程上下文变量完成任务(design 2026-09-01 §6 新契约)。
     *
     * <p>员工端在提交对话框中完成 JSON → 流程变量的映射,本端点只负责:
     * 按 target 声明类型转换、array 类型追加聚合、校验变量已声明,最后 complete 任务。
     * body 非法 JSON 由 Spring 反序列化失败返回 400;变量未声明或类型不符返回 400。
     *
     * @param request 包含 {@code variables} Map 的请求体
     */
    @PostMapping("/{taskId}/complete")
    public void completeTask(@PathVariable String taskId,
                              @RequestBody CompleteTaskRequest request,
                              @AuthenticationPrincipal Jwt jwt) {
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Task not found: " + taskId);
        }
        if (!jwt.getSubject().equals(task.getAssignee())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "任务不属于当前用户");
        }
        Map<String, Object> variables = request.variables();
        if (variables == null) {
            variables = Map.of();
        }
        try {
            completionService.completeWithVariables(task, variables);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }

    private TaskDto toDto(Task task, DshTaskMetaService.TaskMeta taskMeta) {
        Map<String, Object> localVars = task.getTaskLocalVariables();
        String metaJson = localVars == null
            ? null
            : (String) localVars.get(DshTaskListener.TASK_VARIABLE_DSH_META);
        String nodeId = localVars == null
            ? null
            : (String) localVars.get(DshTaskListener.TASK_VARIABLE_NODE_ID);

        DshExtensionProperties meta = null;
        if (metaJson != null && !metaJson.isBlank()) {
            try {
                meta = objectMapper.readValue(metaJson, DshExtensionProperties.class);
            } catch (JsonProcessingException e) {
                throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "Failed to deserialize dsh_node_meta for task " + task.getId(), e);
            }
        }

        DshTaskMetaService.TaskMeta safeMeta = taskMeta == null
            ? new DshTaskMetaService.TaskMeta(null, null, null)
            : taskMeta;
        return new TaskDto(
            task.getId(),
            task.getProcessInstanceId(),
            task.getProcessDefinitionId(),
            task.getTaskDefinitionKey(),
            task.getName(),
            task.getAssignee(),
            toIso(task.getCreateTime()),
            meta,
            nodeId,
            safeMeta.processDefinitionName(),
            safeMeta.startUserId(),
            safeMeta.startUserName()
        );
    }

    private String toIso(Date date) {
        return date == null ? null : Instant.ofEpochMilli(date.getTime()).toString();
    }
}
