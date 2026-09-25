package com.dsh.flowable.api;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * DSH 分析聚合端点(分析看板「业务分析」tab 的数据源)。
 *
 * <p>对 {@code ACT_HI_*} 做定义级聚合(吞吐/耗时/瓶颈节点/办理人时效),供 web-console
 * 分析看板代理调用(透传用户 JWT)。与 {@link DshHistoryController} 同级互补:
 * 历史端点按实例维度查明细,本端点按定义/时间窗维度做统计聚合。
 *
 * <p><b>鉴权</b>:authenticated(复用现有 JWT 过滤链),方法级不做角色细分——敏感度与
 * 历史查询一致,角色细分(web-console 侧 system_admin/app_admin)由代理方实施。
 *
 * <p><b>统一参数</b>:
 * <ul>
 *   <li>{@code days}:统计窗口天数,默认 30,clamp 到 1-365(防误传拖垮全表扫描);</li>
 *   <li>{@code processDefinitionKeys}:可选,逗号分隔的流程定义 key 集合(跨部署版本聚合);
 *       web-console 代理侧对 app_admin 注入名下应用的全量 key 集合,对 system_admin
 *       原样透传用户选定的单个 key(单元素集合)。</li>
 * </ul>
 */
@RestController
@RequestMapping("/dsh/analytics")
public class DshAnalyticsController {

    /** 窗口天数上限:单企业场景 365 天已覆盖年度同比,更大窗口聚合成本陡增。 */
    private static final int MAX_DAYS = 365;
    private static final int DEFAULT_DAYS = 30;

    private final DshAnalyticsQueryService queryService;

    public DshAnalyticsController(DshAnalyticsQueryService queryService) {
        this.queryService = queryService;
    }

    /**
     * 概览统计:窗口内发起/完成/运行中/终止数 + 已结束实例端到端时长均值与 P95。
     */
    @GetMapping("/overview")
    public AnalyticsOverviewDto overview(
        @RequestParam(name = "days", defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKeys", required = false) String processDefinitionKeys
    ) {
        return queryService.overview(clampDays(days), parseKeys(processDefinitionKeys));
    }

    /**
     * 每日吞吐量趋势:发起数按发起日、正常完成数按完成日聚合,合并到同一日期轴。
     */
    @GetMapping("/daily-volumes")
    public List<DailyVolumeDto> dailyVolumes(
        @RequestParam(name = "days", defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKeys", required = false) String processDefinitionKeys
    ) {
        return queryService.dailyVolumes(clampDays(days), parseKeys(processDefinitionKeys));
    }

    /**
     * 节点活动统计:热力图 + TOP 最慢节点数据源(含 sequenceFlow 连线频次)。
     */
    @GetMapping("/activity-stats")
    public List<ActivityStatDto> activityStats(
        @RequestParam(name = "days", defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKeys", required = false) String processDefinitionKeys
    ) {
        return queryService.activityStats(clampDays(days), parseKeys(processDefinitionKeys));
    }

    /**
     * 办理人时效统计:user task 专属,按办理人聚合完成任务数与时长(count 倒序限 50)。
     */
    @GetMapping("/task-stats")
    public List<TaskStatDto> taskStats(
        @RequestParam(name = "days", defaultValue = "30") int days,
        @RequestParam(name = "processDefinitionKeys", required = false) String processDefinitionKeys
    ) {
        return queryService.taskStats(clampDays(days), parseKeys(processDefinitionKeys));
    }

    /** 逗号分隔 key 集合解析为列表(空白项剔除;null/空白 = 不过滤)。 */
    private static List<String> parseKeys(String processDefinitionKeys) {
        if (processDefinitionKeys == null || processDefinitionKeys.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(processDefinitionKeys.split(","))
            .map(String::trim)
            .filter(key -> !key.isEmpty())
            .toList();
    }

    /** days clamp:非正数回退默认 30,超过 365 截断(设计文档 §6 统一参数约定)。 */
    private static int clampDays(int days) {
        if (days <= 0) {
            return DEFAULT_DAYS;
        }
        return Math.min(days, MAX_DAYS);
    }
}
