package com.dsh.console.analytics;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.common.ApiResponse;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.security.AuthContext;
import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 业务分析代理端点(分析看板「业务分析」tab;system_admin + app_admin)。
 *
 * <p>薄代理:参数校验(clamp)后经 {@link FlowableRestClient} 透传用户 JWT 调引擎
 * {@code /dsh/analytics/*}(聚合在引擎侧,本服务不碰 ACT_*)。task-stats 返回的
 * assignee(Supabase user.id)在本侧 join {@code platform_users} 补 displayName
 * ——引擎不 join 治理库用户表,保持引擎对 public schema 只读薄用的边界。
 *
 * <p><b>应用管理员数据可见范围</b>:app_admin 仅能看到名下应用
 * ({@link ApplicationService#listManagedApps},自己创建 + 被共管分配)的已发布流程数据
 * ——未选定流程时注入名下应用的全量流程 key 集合给引擎按集合聚合,选定流程时校验
 * key 归属(非名下 key 返回 404,不泄露存在性)。system_admin 不做范围收敛。
 */
@RestController
@RequestMapping("/api/analytics/business")
@PreAuthorize("hasAnyRole('SYSTEM_ADMIN','APP_ADMIN')")
public class AnalyticsBusinessController {

    private final FlowableRestClient flowableRestClient;
    private final UserJdbcRepository userRepository;
    private final ApplicationService applicationService;
    private final WorkflowDefinitionJdbcRepository workflowRepository;

    public AnalyticsBusinessController(FlowableRestClient flowableRestClient,
                                       UserJdbcRepository userRepository,
                                       ApplicationService applicationService,
                                       WorkflowDefinitionJdbcRepository workflowRepository) {
        this.flowableRestClient = flowableRestClient;
        this.userRepository = userRepository;
        this.applicationService = applicationService;
        this.workflowRepository = workflowRepository;
    }

    /** 解析后的数据可见范围:{@code keys} 传给引擎(空集合=不过滤);{@code restricted}=仅名下集合。 */
    private record AnalyticsScope(List<String> keys, boolean restricted) {}

    /**
     * 流程实例概览统计(发起/完成/运行中/终止数 + 端到端时长均值/P95)。
     */
    @GetMapping("/overview")
    public ApiResponse<JsonNode> overview(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        AnalyticsScope scope = scopeFor(auth, processDefinitionKey);
        if (scope.restricted() && scope.keys().isEmpty()) {
            return ApiResponse.ok(null);
        }
        return ApiResponse.ok(flowableRestClient.getAnalyticsOverview(clampDays(days), scope.keys()));
    }

    /**
     * 每日吞吐量趋势(发起/完成双线)。
     */
    @GetMapping("/daily-volumes")
    public ApiResponse<JsonNode> dailyVolumes(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        AnalyticsScope scope = scopeFor(auth, processDefinitionKey);
        if (scope.restricted() && scope.keys().isEmpty()) {
            return ApiResponse.ok(null);
        }
        return ApiResponse.ok(
            flowableRestClient.getAnalyticsDailyVolumes(clampDays(days), scope.keys()));
    }

    /**
     * 节点活动统计(热力图 + TOP 最慢节点)。
     */
    @GetMapping("/activity-stats")
    public ApiResponse<JsonNode> activityStats(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        AnalyticsScope scope = scopeFor(auth, processDefinitionKey);
        if (scope.restricted() && scope.keys().isEmpty()) {
            return ApiResponse.ok(null);
        }
        return ApiResponse.ok(
            flowableRestClient.getAnalyticsActivityStats(clampDays(days), scope.keys()));
    }

    /**
     * 办理人时效榜(assignee 补 displayName 后返回;无治理记录的用户保持 user.id 原样)。
     */
    @GetMapping("/task-stats")
    public ApiResponse<List<ObjectNode>> taskStats(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        AnalyticsScope scope = scopeFor(auth, processDefinitionKey);
        if (scope.restricted() && scope.keys().isEmpty()) {
            return ApiResponse.ok(List.of());
        }
        JsonNode stats = flowableRestClient.getAnalyticsTaskStats(clampDays(days), scope.keys());
        List<ObjectNode> enriched = new ArrayList<>();
        Map<String, String> displayNames = collectAssignees(stats)
            .isEmpty() ? Map.of()
            : userRepository.findDisplayNamesByAuthSubjects(collectAssignees(stats));
        for (JsonNode item : stats) {
            if (item instanceof ObjectNode object) {
                String assignee = item.path("assignee").asText(null);
                if (assignee != null && displayNames.containsKey(assignee)) {
                    object.put("displayName", displayNames.get(assignee));
                }
                enriched.add(object);
            }
        }
        return ApiResponse.ok(enriched);
    }

    /**
     * 部署版 BPMN XML(热力图渲染用;按部署版本 procdefId,与实例路径图同源机制)。
     *
     * <p>薄代理 {@link FlowableRestClient#getProcessDefinitionBpmnXml}:
     * {@code engine /process-api/repository/process-definitions/{id}/resourcedata}。
     * app_admin 仅可取名下应用的流程定义(procdefId 前缀即 BPMN key,非名下 404)。
     */
    @GetMapping("/bpmn-xml")
    public ApiResponse<String> bpmnXml(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam("processDefinitionId") String processDefinitionId) {
        if (!auth.isSystemAdmin()) {
            String key = processDefinitionId.split(":")[0];
            if (!managedKeys(auth.platformUserId()).contains(key)) {
                throw new NotFoundException("流程定义不存在: " + processDefinitionId);
            }
        }
        return ApiResponse.ok(flowableRestClient.getProcessDefinitionBpmnXml(processDefinitionId));
    }

    /**
     * 解析当前请求的数据可见范围。system_admin:按用户选定 key(单元素集合,未选=不过滤);
     * app_admin:选定 key 必须属于名下集合(否则 404 不泄露存在性),未选定=名下应用
     * 全量已发布流程 key 集合。
     */
    private AnalyticsScope scopeFor(AuthContext auth, String requestedKey) {
        if (auth.isSystemAdmin()) {
            return new AnalyticsScope(
                requestedKey == null || requestedKey.isBlank() ? List.of() : List.of(requestedKey),
                false);
        }
        Set<String> managed = managedKeys(auth.platformUserId());
        if (requestedKey != null && !requestedKey.isBlank()) {
            if (!managed.contains(requestedKey)) {
                throw new NotFoundException("流程定义不存在: " + requestedKey);
            }
            return new AnalyticsScope(List.of(requestedKey), true);
        }
        return new AnalyticsScope(List.copyOf(managed), true);
    }

    /** 名下应用(创建 + 共管)全部已发布流程的 BPMN key 集合(去重)。 */
    private Set<String> managedKeys(UUID platformUserId) {
        Set<String> keys = new HashSet<>();
        for (ApplicationDto app : applicationService.listManagedApps(platformUserId)) {
            for (WorkflowDefinitionDto wf : workflowRepository.listPublishedByApp(app.id())) {
                if (wf.bpmnProcessKey() != null && !wf.bpmnProcessKey().isBlank()) {
                    keys.add(wf.bpmnProcessKey());
                }
            }
        }
        return keys;
    }

    /** 收集 task-stats 响应的全部 assignee(批量查 displayName,避免 N+1)。 */
    private static List<String> collectAssignees(JsonNode stats) {
        List<String> assignees = new ArrayList<>();
        if (stats != null && stats.isArray()) {
            for (JsonNode item : stats) {
                String assignee = item.path("assignee").asText(null);
                if (assignee != null && !assignees.contains(assignee)) {
                    assignees.add(assignee);
                }
            }
        }
        return assignees;
    }

    /** days clamp(1-365,非正回退 30):与引擎端点约定一致,双保险。 */
    private static int clampDays(int days) {
        if (days <= 0) {
            return 30;
        }
        return Math.min(days, 365);
    }
}
