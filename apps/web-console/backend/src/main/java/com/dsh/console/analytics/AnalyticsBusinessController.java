package com.dsh.console.analytics;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.user.UserJdbcRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.security.access.prepost.PreAuthorize;
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
 */
@RestController
@RequestMapping("/api/analytics/business")
@PreAuthorize("hasAnyRole('SYSTEM_ADMIN','APP_ADMIN')")
public class AnalyticsBusinessController {

    private final FlowableRestClient flowableRestClient;
    private final UserJdbcRepository userRepository;

    public AnalyticsBusinessController(FlowableRestClient flowableRestClient,
                                       UserJdbcRepository userRepository) {
        this.flowableRestClient = flowableRestClient;
        this.userRepository = userRepository;
    }

    /**
     * 流程实例概览统计(发起/完成/运行中/终止数 + 端到端时长均值/P95)。
     */
    @GetMapping("/overview")
    public ApiResponse<JsonNode> overview(
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        return ApiResponse.ok(
            flowableRestClient.getAnalyticsOverview(clampDays(days), processDefinitionKey));
    }

    /**
     * 每日吞吐量趋势(发起/完成双线)。
     */
    @GetMapping("/daily-volumes")
    public ApiResponse<JsonNode> dailyVolumes(
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        return ApiResponse.ok(
            flowableRestClient.getAnalyticsDailyVolumes(clampDays(days), processDefinitionKey));
    }

    /**
     * 节点活动统计(热力图 + TOP 最慢节点)。
     */
    @GetMapping("/activity-stats")
    public ApiResponse<JsonNode> activityStats(
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        return ApiResponse.ok(
            flowableRestClient.getAnalyticsActivityStats(clampDays(days), processDefinitionKey));
    }

    /**
     * 办理人时效榜(assignee 补 displayName 后返回;无治理记录的用户保持 user.id 原样)。
     */
    @GetMapping("/task-stats")
    public ApiResponse<List<ObjectNode>> taskStats(
        @RequestParam(defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey) {
        JsonNode stats = flowableRestClient.getAnalyticsTaskStats(clampDays(days), processDefinitionKey);
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

    /**
     * 部署版 BPMN XML(热力图渲染用;按部署版本 procdefId,与实例路径图同源机制)。
     *
     * <p>薄代理 {@link FlowableRestClient#getProcessDefinitionBpmnXml}:
     * {@code engine /process-api/repository/process-definitions/{id}/resourcedata}。
     */
    @GetMapping("/bpmn-xml")
    public ApiResponse<String> bpmnXml(
        @RequestParam("processDefinitionId") String processDefinitionId) {
        return ApiResponse.ok(flowableRestClient.getProcessDefinitionBpmnXml(processDefinitionId));
    }

    /** days clamp(1-365,非正回退 30):与引擎端点约定一致,双保险。 */
    private static int clampDays(int days) {
        if (days <= 0) {
            return 30;
        }
        return Math.min(days, 365);
    }
}
