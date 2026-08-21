package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.history.HistoricActivityInstance;
import org.flowable.engine.history.HistoricProcessInstance;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.task.api.history.HistoricTaskInstance;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * DSH 历史/审计薄封装 REST 端点(参见 SPEC §10.1 审计接口要求)。
 *
 * <p>Flowable 自带 REST 在 {@code /process-api/history/*} 暴露全部历史查询能力,但返回字段
 * 是 Flowable 原生模型,不含 {@code dsh_node_meta} 等业务字段,且过滤参数较多不便直接给前端用。
 * 本端点按 DSH 业务常用维度(按实例/按处理人/按状态)简化查询,并拼装 dsh 元数据 POJO,
 * 供 Web Console 审计页面和 DSH enterprise profile 退回/跳转参考使用。
 *
 * <p>覆盖范围(V1):
 * <ul>
 *   <li>{@code GET /dsh/history/tasks}:查历史任务(可选按实例/处理人/完成状态过滤)。</li>
 *   <li>{@code GET /dsh/history/process-instances}:查历史实例(可选按发起人/状态/key 过滤)。</li>
 *   <li>{@code GET /dsh/history/activities}:查历史活动(按实例 id 必填,回溯流程走过的全部节点)。</li>
 * </ul>
 *
 * <p><b>历史级别</b>:由 {@link com.dsh.flowable.config.FlowableConfig} 配置 {@code HistoryLevel.FULL},
 * 所有历史表({@code ACT_HI_*})都写入数据,本端点查询前提成立。
 *
 * <p><b>鉴权</b>:V1 单企业内部信任,任何已认证用户都能查全部历史;V2 可加按部门/角色可见范围。
 *
 * <p><b>分页</b>:V1 用 page/size 简单分页(默认 size=50,最大 200),返回 plain list;
 * V2 可改为 Spring HATEOAS 或 Page 对象。
 */
@RestController
@RequestMapping("/dsh/history")
public class DshHistoryController {

    /** 单页最大返回条数,防止前端误传大 size 拖垮引擎。 */
    private static final int MAX_PAGE_SIZE = 200;
    private static final int DEFAULT_PAGE_SIZE = 50;

    private final HistoryService historyService;
    private final RepositoryService repositoryService;
    private final ObjectMapper objectMapper;

    public DshHistoryController(HistoryService historyService,
                                  RepositoryService repositoryService,
                                  ObjectMapper objectMapper) {
        this.historyService = historyService;
        this.repositoryService = repositoryService;
        this.objectMapper = objectMapper;
    }

    /**
     * 查历史任务,可按实例/处理人/完成状态过滤。
     *
     * <p>用 {@code includeTaskLocalVariables} 一次查全部 local 变量,避免逐条回查拿 dsh_node_meta。
     *
     * @param processInstanceId 可选;按实例过滤
     * @param assignee          可选;按处理人(Supabase user.id)过滤;传 JWT sub 可查"我处理过的"
     * @param finished          可选;{@code true} 只看已完成,{@code false} 只看进行中,不传不过滤
     * @param page              页码(0-based),默认 0
     * @param size              单页条数,默认 50,上限 200
     */
    @GetMapping("/tasks")
    public List<HistoricTaskDto> getHistoricTasks(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @RequestParam(name = "assignee", required = false) String assignee,
        @RequestParam(name = "finished", required = false) Boolean finished,
        @RequestParam(name = "page", defaultValue = "0") int page,
        @RequestParam(name = "size", defaultValue = "50") int size,
        @AuthenticationPrincipal Jwt jwt
    ) {
        // 便捷入口:不传 assignee 时默认查当前 JWT 用户的历史任务("我处理过的")
        // 如果前端想查全部历史(管理员视图),显式传 assignee=__all__ 表示不要按 user 过滤
        String effectiveAssignee = assignee;
        if (effectiveAssignee == null && jwt != null) {
            // V1 默认按当前用户过滤,避免一次性拉全企业历史;管理员可显式传 assignee=__all__
            // 但 __all__ 不在 assignee 字段语义内,此处简化:不传 assignee 即查当前用户
            effectiveAssignee = jwt.getSubject();
        }

        int safeSize = clampSize(size);
        int firstResult = Math.max(0, page) * safeSize;

        var query = historyService.createHistoricTaskInstanceQuery()
            .includeTaskLocalVariables()
            .orderByHistoricTaskInstanceStartTime().desc();
        if (processInstanceId != null && !processInstanceId.isBlank()) {
            query.processInstanceId(processInstanceId);
        }
        if (effectiveAssignee != null && !effectiveAssignee.isBlank()) {
            query.taskAssignee(effectiveAssignee);
        }
        if (Boolean.TRUE.equals(finished)) {
            query.finished();
        } else if (Boolean.FALSE.equals(finished)) {
            query.unfinished();
        }

        List<HistoricTaskInstance> tasks = query.listPage(firstResult, safeSize);
        return tasks.stream().map(this::toDto).toList();
    }

    /**
     * 查历史流程实例,可按发起人/状态/key 过滤。
     *
     * <p>不传任何过滤参数时返回全部历史实例(按发起时间倒序)。管理员审计用;
     * 普通用户建议传 {@code startedBy} 查自己发起的实例("我发起过的")。
     *
     * @param startedBy             可选;按发起人 user.id 过滤
     * @param finished              可选;{@code true} 只看已完成,{@code false} 只看运行中
     * @param processDefinitionKey  可选;按流程定义 key 过滤(同流程不同版本一并查)
     * @param page                  页码(0-based),默认 0
     * @param size                  单页条数,默认 50,上限 200
     */
    @GetMapping("/process-instances")
    public List<HistoricProcessInstanceDto> getHistoricProcessInstances(
        @RequestParam(name = "startedBy", required = false) String startedBy,
        @RequestParam(name = "finished", required = false) Boolean finished,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey,
        @RequestParam(name = "page", defaultValue = "0") int page,
        @RequestParam(name = "size", defaultValue = "50") int size
    ) {
        int safeSize = clampSize(size);
        int firstResult = Math.max(0, page) * safeSize;

        var query = historyService.createHistoricProcessInstanceQuery()
            .orderByProcessInstanceStartTime().desc();
        if (startedBy != null && !startedBy.isBlank()) {
            query.startedBy(startedBy);
        }
        if (Boolean.TRUE.equals(finished)) {
            query.finished();
        } else if (Boolean.FALSE.equals(finished)) {
            query.unfinished();
        }
        if (processDefinitionKey != null && !processDefinitionKey.isBlank()) {
            query.processDefinitionKey(processDefinitionKey);
        }

        List<HistoricProcessInstance> instances = query.listPage(firstResult, safeSize);
        return instances.stream().map(this::toDto).toList();
    }

    /**
     * 查历史活动(全部节点类型),按实例 id 必填。
     *
     * <p>用于审计"流程走过了哪些节点、何时走过、停留多久",覆盖 UserTask / ServiceTask /
     * Gateway / Event 等所有 BPMN 节点;与历史任务(只覆盖 UserTask)互补。
     *
     * <p>不分页:单实例的 ACT_HI_ACTINST 条目数有限(流程节点数 × 实例运行路径数,通常 < 100),
     * 一次性返回即可。
     *
     * @param processInstanceId 必填;按实例 id 过滤
     */
    @GetMapping("/activities")
    public List<HistoricActivityDto> getHistoricActivities(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId
    ) {
        if (processInstanceId == null || processInstanceId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processInstanceId parameter is required for /dsh/history/activities");
        }
        List<HistoricActivityInstance> activities = historyService.createHistoricActivityInstanceQuery()
            .processInstanceId(processInstanceId)
            .orderByHistoricActivityInstanceStartTime().asc()
            .list();
        return activities.stream().map(this::toDto).toList();
    }

    private HistoricTaskDto toDto(HistoricTaskInstance task) {
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
                    "Failed to deserialize dsh_node_meta for historic task " + task.getId(), e);
            }
        }

        return new HistoricTaskDto(
            task.getId(),
            task.getProcessInstanceId(),
            task.getProcessDefinitionId(),
            task.getTaskDefinitionKey(),
            task.getName(),
            task.getAssignee(),
            toIso(task.getStartTime()),
            toIso(task.getEndTime()),
            task.getDurationInMillis(),
            task.getDeleteReason(),
            meta,
            nodeId
        );
    }

    private HistoricProcessInstanceDto toDto(HistoricProcessInstance instance) {
        // 流程定义名称/key/版本 Flowable 7 在 HistoricProcessInstance 上不一定全有;补查 RepositoryService
        // 用 procdefId 查 ProcessDefinition 拿 name/key/version,避免依赖 historic 接口字段差异。
        String defName = null;
        String defKey = null;
        Integer defVersion = null;
        if (instance.getProcessDefinitionId() != null) {
            ProcessDefinition def = repositoryService.createProcessDefinitionQuery()
                .processDefinitionId(instance.getProcessDefinitionId())
                .singleResult();
            if (def != null) {
                defName = def.getName();
                defKey = def.getKey();
                defVersion = def.getVersion();
            }
        }

        return new HistoricProcessInstanceDto(
            instance.getId(),
            instance.getProcessDefinitionId(),
            defKey,
            defName,
            defVersion,
            instance.getBusinessKey(),
            instance.getStartUserId(),
            toIso(instance.getStartTime()),
            toIso(instance.getEndTime()),
            instance.getDurationInMillis(),
            instance.getDeleteReason(),
            instance.getSuperProcessInstanceId()
        );
    }

    private HistoricActivityDto toDto(HistoricActivityInstance activity) {
        return new HistoricActivityDto(
            activity.getId(),
            activity.getProcessInstanceId(),
            activity.getProcessDefinitionId(),
            activity.getActivityId(),
            activity.getActivityName(),
            activity.getActivityType(),
            activity.getAssignee(),
            toIso(activity.getStartTime()),
            toIso(activity.getEndTime()),
            activity.getDurationInMillis()
        );
    }

    private String toIso(Date date) {
        return date == null ? null : Instant.ofEpochMilli(date.getTime()).toString();
    }

    private static int clampSize(int size) {
        if (size <= 0) {
            return DEFAULT_PAGE_SIZE;
        }
        return Math.min(size, MAX_PAGE_SIZE);
    }
}
