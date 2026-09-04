package com.dsh.console.runtime;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.runtime.dto.ProcessInstanceDto;
import com.dsh.console.runtime.dto.StartFormVariableDto;
import com.dsh.console.runtime.dto.StartProcessInstanceRequest;
import com.dsh.console.runtime.dto.TaskDto;
import com.dsh.console.security.AuthContext;
import com.dsh.console.user.UserService;
import com.dsh.console.user.dto.UserDto;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 流程实例运行时业务编排。
 *
 * <p>V1 由 Web Console 后端发起实例启动与查询,作为端到端联调入口(spec §6.3):
 * <ul>
 *   <li>启动实例:校验 workflow_definition 已发布 + 应用访问权限;注入应用隔离三变量
 *       {@code dsh_applicant_user_id} / {@code dsh_app_id} / {@code dsh_workflow_definition_id}
 *       (spec §7.7.4 + §13.4);调 Flowable REST。</li>
 *   <li>列实例:V1 只列运行中实例(runtime);appId 非空时按应用过滤(app_admin 必须指定 appId)。</li>
 *   <li>查实例详情:从 procdefId 反查 workflow_definitions 补齐 appId / workflowDefinitionId。</li>
 *   <li>列实例任务:透传 Flowable runtime tasks。</li>
 *   <li>终止实例:管理员干预,记审计(spec §11.2)。</li>
 *   <li>完成任务:V1 简化的人工干预通道,不做输出校验(spec §8.8 在 DSH task-api 层)。</li>
 * </ul>
 *
 * <p>应用隔离(spec §13.4):所有写操作和查详情都校验当前用户能访问目标 workflow_definition
 * 所属的应用(system_admin 全部;app_admin 仅自己管理应用)。
 */
@Service
public class ProcessInstanceService {

    private final FlowableRestClient flowableRestClient;
    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationService applicationService;
    private final AuditService auditService;
    private final ProcessStartValidationService startValidation;
    private final UserService userService;

    public ProcessInstanceService(FlowableRestClient flowableRestClient,
                                  WorkflowDefinitionJdbcRepository workflowRepository,
                                  ApplicationService applicationService,
                                  AuditService auditService,
                                  ProcessStartValidationService startValidation,
                                  UserService userService) {
        this.flowableRestClient = flowableRestClient;
        this.workflowRepository = workflowRepository;
        this.applicationService = applicationService;
        this.auditService = auditService;
        this.startValidation = startValidation;
        this.userService = userService;
    }

    /**
     * 生成启动表单变量清单(已部署 BPMN 的 start-param 声明)。
     *
     * <p>按部署版本而非草稿,与启动校验同一声明源。
     */
    public List<StartFormVariableDto> startForm(UUID workflowDefinitionId, AuthContext auth) {
        WorkflowDefinitionDto wf = requirePublished(workflowDefinitionId);
        applicationService.checkCanAccessApp(auth, wf.appId());
        return startValidation.startForm(
            startValidation.loadDeclarations(wf.publishedProcdefId()));
    }

    /**
     * 启动流程实例。
     *
     * <p>启动校验(design 2026-09-01 §4 严格声明制):按已部署 BPMN 的上下文声明
     * 拒绝未声明/未标记 start-param 的传入变量,按类型反序列化,initial 兜底注入。
     */
    @Transactional
    public ProcessInstanceDto start(StartProcessInstanceRequest request, AuthContext auth) {
        WorkflowDefinitionDto wf = requirePublished(request.workflowDefinitionId());
        applicationService.checkCanAccessApp(auth, wf.appId());

        Map<String, Object> contextVariables = startValidation.buildVariables(
            startValidation.loadDeclarations(wf.publishedProcdefId()),
            request.variables());

        // 应用隔离三变量(spec §7.7.4 + §13.4)与上下文变量合并。
        // dsh_applicant_user_id 存流程身份(auth_subject = JWT sub),与引擎侧
        // assignee/候选人同一 ID 体系,SoD not-applicant 比较才能命中。
        Map<String, Object> variables = new LinkedHashMap<>();
        variables.put("dsh_applicant_user_id", auth.authSubject());
        variables.put("dsh_app_id", wf.appId().toString());
        variables.put("dsh_workflow_definition_id", wf.id().toString());
        variables.putAll(contextVariables);

        JsonNode instance = flowableRestClient.startProcessInstance(
            wf.publishedProcdefId(), request.businessKey(), request.name(), variables);

        ProcessInstanceDto dto = toDto(instance, wf, new java.util.HashMap<>());
        auditService.record("PROCESS_INSTANCE_START", "workflow_definition", null,
            auth.platformUserId(), Map.of(
                "instanceId", dto.id(),
                "workflowDefinitionId", wf.id(),
                "appId", wf.appId(),
                "businessKey", String.valueOf(request.businessKey())));
        return dto;
    }

    /**
     * 列运行中实例。
     *
     * <p>给 {@code appId} 时只列该应用下的实例;不给时 system_admin 查全部,
     * app_admin 自动汇总自己管理的所有应用下的实例。
     */
    public List<ProcessInstanceDto> list(UUID appIdFilter, String procdefIdFilter,
                                         int start, int size, AuthContext auth) {
        // procdefIdFilter 非空:反查 workflow_definition 校验应用权限
        if (procdefIdFilter != null) {
            WorkflowDefinitionDto wf = workflowRepository.findByProcdefId(procdefIdFilter)
                .orElseThrow(() -> new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                    "procdefId 未对应任何 published workflow_definition: " + procdefIdFilter));
            applicationService.checkCanAccessApp(auth, wf.appId());
            JsonNode resp = flowableRestClient.listRuntimeProcessInstances(procdefIdFilter, start, size);
            return parseInstanceList(resp, wf);
        }

        // appIdFilter 非空:按单个应用过滤
        if (appIdFilter != null) {
            applicationService.checkCanAccessApp(auth, appIdFilter);
            return listInstancesByApp(appIdFilter, start, size);
        }

        // appIdFilter 和 procdefIdFilter 都为空
        if (auth.isSystemAdmin()) {
            JsonNode resp = flowableRestClient.listRuntimeProcessInstances(null, start, size);
            return parseInstanceList(resp);
        }

        // app_admin: 自动汇总自己管理的所有应用下的实例
        List<ApplicationDto> apps = applicationService.listManagedApps(auth.platformUserId());
        List<ProcessInstanceDto> all = new ArrayList<>();
        for (ApplicationDto app : apps) {
            all.addAll(listInstancesByApp(app.id(), start, size));
        }
        return all;
    }

    private List<ProcessInstanceDto> listInstancesByApp(UUID appId, int start, int size) {
        List<WorkflowDefinitionDto> wfs = workflowRepository.listPublishedByApp(appId);
        List<ProcessInstanceDto> all = new ArrayList<>();
        for (WorkflowDefinitionDto wf : wfs) {
            JsonNode resp = flowableRestClient.listRuntimeProcessInstances(
                wf.publishedProcdefId(), start, size);
            all.addAll(parseInstanceList(resp, wf));
        }
        return all;
    }

    /**
     * 查运行中实例详情。
     */
    public ProcessInstanceDto getById(String instanceId, AuthContext auth) {
        JsonNode instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        if (instance == null) {
            throw new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                "流程实例不存在: " + instanceId);
        }
        WorkflowDefinitionDto wf = resolveWorkflowDefinition(instance);
        applicationService.checkCanAccessApp(auth, wf.appId());
        return toDto(instance, wf, new java.util.HashMap<>());
    }

    /**
     * 列实例当前任务(runtime tasks)。
     */
    public List<TaskDto> listTasks(String instanceId, AuthContext auth) {
        JsonNode instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        if (instance == null) {
            throw new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                "流程实例不存在: " + instanceId);
        }
        WorkflowDefinitionDto wf = resolveWorkflowDefinition(instance);
        applicationService.checkCanAccessApp(auth, wf.appId());

        JsonNode resp = flowableRestClient.listTasksByProcessInstance(instanceId);
        return parseTaskList(resp);
    }

    /**
     * 终止实例(spec §11.2:管理员强制结束)。
     */
    @Transactional
    public void terminate(String instanceId, String reason, AuthContext auth) {
        JsonNode instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        if (instance == null) {
            throw new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                "流程实例不存在或已结束: " + instanceId);
        }
        WorkflowDefinitionDto wf = resolveWorkflowDefinition(instance);
        applicationService.checkCanAccessApp(auth, wf.appId());

        flowableRestClient.deleteProcessInstance(instanceId, reason);
        auditService.record("PROCESS_INSTANCE_TERMINATE", "workflow_definition", null,
            auth.platformUserId(), Map.of(
                "instanceId", instanceId,
                "workflowDefinitionId", wf.id(),
                "appId", wf.appId(),
                "deleteReason", reason == null ? "" : reason));
    }

    /**
     * 完成任务(V1 简化:不做输出校验,直接转发 Flowable)。
     */
    @Transactional
    public void completeTask(String taskId, Map<String, Object> variables, AuthContext auth) {
        flowableRestClient.completeTask(taskId, variables);
        auditService.record("TASK_COMPLETE", "workflow_definition", null,
            auth.platformUserId(), Map.of(
                "taskId", taskId,
                "operator", auth.platformUserId().toString()));
    }

    // ===== 内部辅助 =====

    /** 查流程定义并断言已发布(published_procdef_id 就绪);startForm/start 共用。 */
    private WorkflowDefinitionDto requirePublished(UUID workflowDefinitionId) {
        WorkflowDefinitionDto wf = workflowRepository.findById(workflowDefinitionId)
        .orElseThrow(() -> new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
            "流程定义不存在: " + workflowDefinitionId));
        if (!"published".equalsIgnoreCase(wf.status())) {
            throw new IllegalArgumentException(
                "流程定义状态非 published,不允许启动实例: " + wf.status());
        }
        if (wf.publishedProcdefId() == null || wf.publishedProcdefId().isBlank()) {
            throw new IllegalStateException("流程定义已发布但 published_procdef_id 为空(数据不一致)");
        }
        return wf;
    }

    /**
     * 从 Flowable runtime instance JSON 反查 workflow_definition。
     *
     * @throws NotFoundException procdefId 不对应任何 workflow_definition(数据不一致)
     */
    private WorkflowDefinitionDto resolveWorkflowDefinition(JsonNode instance) {
        String procdefId = instance.path("processDefinitionId").asText();
        return workflowRepository.findByProcdefId(procdefId)
        .orElseThrow(() -> new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
            "procdefId 未对应任何 workflow_definition(数据不一致): " + procdefId));
    }

    private List<ProcessInstanceDto> parseInstanceList(JsonNode resp) {
        List<ProcessInstanceDto> result = new ArrayList<>();
        if (resp == null) {
            return result;
        }
        JsonNode data = resp.path("data");
        if (data == null || !data.isArray()) {
            return result;
        }
        Map<String, String> nameCache = new java.util.HashMap<>();
        for (JsonNode node : data) {
            String procdefId = node.path("processDefinitionId").asText();
            WorkflowDefinitionDto wf = workflowRepository.findByProcdefId(procdefId).orElse(null);
            result.add(toDto(node, wf, nameCache));
        }
        return result;
    }

    private List<ProcessInstanceDto> parseInstanceList(JsonNode resp, WorkflowDefinitionDto wf) {
        List<ProcessInstanceDto> result = new ArrayList<>();
        if (resp == null) {
            return result;
        }
        JsonNode data = resp.path("data");
        if (data == null || !data.isArray()) {
            return result;
        }
        Map<String, String> nameCache = new java.util.HashMap<>();
        for (JsonNode node : data) {
            result.add(toDto(node, wf, nameCache));
        }
        return result;
    }

    private List<TaskDto> parseTaskList(JsonNode resp) {
        List<TaskDto> result = new ArrayList<>();
        if (resp == null) {
            return result;
        }
        JsonNode data = resp.path("data");
        if (data == null || !data.isArray()) {
            return result;
        }
        Map<String, String> nameCache = new java.util.HashMap<>();
        for (JsonNode node : data) {
            String assignee = textOrNull(node, "assignee");
            String assigneeName = resolveUserDisplayName(assignee, nameCache);
            result.add(new TaskDto(
                textOrNull(node, "id"),
                textOrNull(node, "name"),
                assignee,
                assigneeName,
                textOrNull(node, "owner"),
                parseTime(node, "createTime"),
                parseTime(node, "dueDate"),
                textOrNull(node, "processInstanceId"),
                textOrNull(node, "processDefinitionId"),
                textOrNull(node, "taskDefinitionKey"),
                textOrNull(node, "description")
            ));
        }
        return result;
    }

    /**
     * 按 auth_subject 反查 platform_users.display_name(任务办理人、实例发起人共用)。
     *
     * <p>V1 用单条查询 + 缓存;任务/实例数通常很少,可接受。查不到时返回 null(保留原 ID 显示)。
     */
    private String resolveUserDisplayName(String userId, Map<String, String> cache) {
        if (userId == null || userId.isBlank()) {
            return null;
        }
        return cache.computeIfAbsent(userId, key -> {
            UserDto user = userService.findMe(key);
            return user == null ? null : user.displayName();
        });
    }

    private ProcessInstanceDto toDto(JsonNode node, WorkflowDefinitionDto wf, Map<String, String> nameCache) {
        if (node == null) {
            return null;
        }
        String startUserId = textOrNull(node, "startUserId");
        return new ProcessInstanceDto(
            textOrNull(node, "id"),
            textOrNull(node, "businessKey"),
            textOrNull(node, "processDefinitionId"),
            textOrNull(node, "processDefinitionKey"),
            textOrNull(node, "processDefinitionName"),
            textOrNull(node, "name"),
            startUserId,
            resolveUserDisplayName(startUserId, nameCache),
            parseTime(node, "startTime"),
            node.path("suspended").asBoolean(false),
            node.path("ended").asBoolean(false),
            textOrNull(node, "deleteReason"),
            parseTime(node, "endTime"),
            wf == null ? null : wf.id(),
            wf == null ? null : wf.appId(),
            wf == null ? null : wf.name()
        );
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.path(field);
        if (v == null || v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText();
        return s == null || s.isEmpty() ? null : s;
    }

    private static OffsetDateTime parseTime(JsonNode node, String field) {
        String s = textOrNull(node, field);
        if (s == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(s);
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
