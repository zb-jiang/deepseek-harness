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
 * <p>覆盖范围(V1):
 * <ul>
 *   <li>{@code GET /dsh/tasks/my-tasks}:查当前 JWT 用户已认领的任务(assignee = sub)。</li>
 *   <li>{@code GET /dsh/tasks/{taskId}}:查单个任务详情,含 dsh 元数据。</li>
 * </ul>
 *
 * <p>未覆盖的能力(直接用 Flowable 自带 REST):
 * <ul>
 *   <li>候选任务查询(按 candidateGroup/角色继承展开):DSH task-api 自行实现,
 *       调 {@code /process-api/runtime/tasks?candidateGroup=...}。</li>
 *   <li>任务认领/转交/完成:直接调 {@code /process-api/runtime/tasks/{taskId}}。</li>
 *   <li>输出校验(SPEC §7.8):DSH task-api 的 complete 端点执行,不在 Flowable 引擎侧。</li>
 * </ul>
 */
@RestController
@RequestMapping("/dsh/tasks")
public class DshTaskController {

    private final TaskService taskService;
    private final ObjectMapper objectMapper;

    public DshTaskController(TaskService taskService, ObjectMapper objectMapper) {
        this.taskService = taskService;
        this.objectMapper = objectMapper;
    }

    /**
     * 查询当前 JWT 用户已认领的任务(assignee = sub)。
     *
     * <p>不含候选任务(未认领);候选任务由 task-api 按角色集查 candidateGroup 拿。
     * 用 {@code includeTaskLocalVariables} 一次查全部 local 变量,避免 N+1。
     */
    @GetMapping("/my-tasks")
    public List<TaskDto> getMyTasks(@AuthenticationPrincipal Jwt jwt) {
        String userId = jwt.getSubject();
        List<Task> tasks = taskService.createTaskQuery()
            .taskAssignee(userId)
            .includeTaskLocalVariables()
            .orderByTaskCreateTime().desc()
            .list();
        return tasks.stream().map(this::toDto).toList();
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
        return toDto(task);
    }

    private TaskDto toDto(Task task) {
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

        return new TaskDto(
            task.getId(),
            task.getProcessInstanceId(),
            task.getProcessDefinitionId(),
            task.getTaskDefinitionKey(),
            task.getName(),
            task.getAssignee(),
            toIso(task.getCreateTime()),
            meta,
            nodeId
        );
    }

    private String toIso(Date date) {
        return date == null ? null : Instant.ofEpochMilli(date.getTime()).toString();
    }
}
