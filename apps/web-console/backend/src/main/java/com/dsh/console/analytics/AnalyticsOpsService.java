package com.dsh.console.analytics;

import com.dsh.console.analytics.dto.OpsSummaryDto;
import com.dsh.console.analytics.dto.SeriesPointDto;
import com.dsh.console.config.AnalyticsProperties;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 运维健康查询编排(实时卡片 + 趋势折线;设计 2026-09-25 §8.3)。
 *
 * <p>速率/时延/成功率的窗口差分在 Service 层完成(对 dsh_metrics_sample 的
 * COUNT/TOTAL_TIME 序列首尾相减),不在前端算。
 */
@Service
public class AnalyticsOpsService {

    /** 成功率/时延的统计窗口。 */
    private static final Duration SUMMARY_WINDOW = Duration.ofHours(1);

    private final MetricsJdbcRepository repository;
    private final AnalyticsProperties properties;

    public AnalyticsOpsService(MetricsJdbcRepository repository, AnalyticsProperties properties) {
        this.repository = repository;
        this.properties = properties;
    }

    /**
     * 指标时间序列(折线数据;时间窗必填,防止全表扫)。
     */
    public List<SeriesPointDto> series(String metric, String statistic,
                                       OffsetDateTime from, OffsetDateTime to) {
        return repository.series(metric, statistic, from, to).stream()
            .map(p -> new SeriesPointDto(p.ts(), p.value()))
            .toList();
    }

    /**
     * 运维汇总:各指标最新 VALUE + backend task 近 1h 成功率/时延 + 升级触发数。
     */
    public OpsSummaryDto summary() {
        Map<String, Double> latest = repository.latestValues(properties.getMetrics());

        OffsetDateTime from = OffsetDateTime.now(ZoneOffset.UTC).minus(SUMMARY_WINDOW);
        List<MetricsJdbcRepository.MetricRow> rows = repository.rowsSince(List.of(
            OpsSummaryDto.BACKEND_TASK_SUCCESS,
            OpsSummaryDto.BACKEND_TASK_FAILED,
            OpsSummaryDto.ESCALATION), from);

        long successDelta = delta(rows, OpsSummaryDto.BACKEND_TASK_SUCCESS, "COUNT");
        long failedDelta = delta(rows, OpsSummaryDto.BACKEND_TASK_FAILED, "COUNT");
        double successTimeDelta = deltaDouble(rows, OpsSummaryDto.BACKEND_TASK_SUCCESS, "TOTAL_TIME");
        long escalationDelta = delta(rows, OpsSummaryDto.ESCALATION, "COUNT");

        long totalDelta = successDelta + failedDelta;
        Double successRate = totalDelta > 0
            ? (double) successDelta / totalDelta : null;
        Double avgLatency = successDelta > 0
            ? successTimeDelta / successDelta : null;

        return new OpsSummaryDto(latest, successRate, totalDelta, avgLatency, escalationDelta);
    }

    /** 指标+statistic 序列的窗口增量(末值 - 首值;样本不足 2 个返回 0)。 */
    private static long delta(List<MetricsJdbcRepository.MetricRow> rows,
                              String metric, String statistic) {
        return Math.round(deltaDouble(rows, metric, statistic));
    }

    private static double deltaDouble(List<MetricsJdbcRepository.MetricRow> rows,
                                      String metric, String statistic) {
        double first = Double.NaN;
        double last = Double.NaN;
        for (MetricsJdbcRepository.MetricRow row : rows) {
            if (metric.equals(row.metric()) && statistic.equals(row.statistic())) {
                if (Double.isNaN(first)) {
                    first = row.value();
                }
                last = row.value();
            }
        }
        if (Double.isNaN(first) || Double.isNaN(last)) {
            return 0;
        }
        return last - first;
    }
}
