package com.dsh.console.analytics;

import com.dsh.console.analytics.dto.OpsSummaryDto;
import com.dsh.console.analytics.dto.SeriesPointDto;
import com.dsh.console.common.ApiResponse;
import java.time.OffsetDateTime;
import java.util.List;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 运维健康查询端点(分析看板「运维健康」tab,仅 system_admin)。
 *
 * <p>数据源 = web-console 定时轮询引擎落库的 {@code dsh_metrics_sample} 表
 * ({@link MetricsPoller});引擎健康指标不含敏感信息,但只读边界按角色收紧:
 * 前端菜单按角色显隐 + 本类 {@code @PreAuthorize} 双保险。
 */
@RestController
@RequestMapping("/api/analytics/ops")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class AnalyticsOpsController {

    private final AnalyticsOpsService opsService;

    public AnalyticsOpsController(AnalyticsOpsService opsService) {
        this.opsService = opsService;
    }

    /**
     * 指标时间序列(趋势折线)。
     *
     * @param metric    指标名(带 tag 展开的落库名,如 dsh.backend.task{outcome=success})
     * @param statistic 统计口径:VALUE(默认)/COUNT/TOTAL_TIME/MAX
     * @param from      窗口起点(ISO 8601)
     * @param to        窗口终点(ISO 8601;缺省=当前时刻)
     */
    @GetMapping("/series")
    public ApiResponse<List<SeriesPointDto>> series(
        @RequestParam String metric,
        @RequestParam(defaultValue = "VALUE") String statistic,
        @RequestParam OffsetDateTime from,
        @RequestParam(required = false) OffsetDateTime to) {
        OffsetDateTime effectiveTo = to == null ? OffsetDateTime.now() : to;
        return ApiResponse.ok(opsService.series(metric, statistic, from, effectiveTo));
    }

    /**
     * 运维汇总(实时卡片:job 积压/连接池/JVM 最新值 + backend task 1h 成功率/时延 + 升级数)。
     */
    @GetMapping("/summary")
    public ApiResponse<OpsSummaryDto> summary() {
        return ApiResponse.ok(opsService.summary());
    }
}
