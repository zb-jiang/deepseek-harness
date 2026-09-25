package com.dsh.console.analytics;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.dsh_metrics_sample} 表数据访问(分析看板运维指标存储)。
 *
 * <p>表结构(建表 DDL 见 docs/plans/2026-09-21-local-pg-setup-guide.md 手册):
 * id / metric / statistic / value / ts。每次轮询每个指标的每个 statistic 一行
 * (VALUE/COUNT/TOTAL_TIME/MAX),带 tag 的指标落库名形如
 * {@code dsh.backend.task{outcome=success}}。
 *
 * <p>汇总/差分:速率类指标(COUNT/TOTAL_TIME 是单调累计值)的窗口差分在
 * Service 层对序列做首尾相减,不在 SQL 里做。
 */
@Repository
public class MetricsJdbcRepository {

    /** 单次轮询批量插入的单个采样点。 */
    public record MetricSample(String metric, String statistic, double value) {
    }

    /** 时间序列点(折线图数据)。 */
    public record SeriesPoint(OffsetDateTime ts, double value) {
    }

    /** 汇总差分用的原始行。 */
    public record MetricRow(String metric, String statistic, double value, OffsetDateTime ts) {
    }

    private final JdbcClient jdbcClient;

    public MetricsJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /** 批量插入一次轮询的采样点(同一 ts)。 */
    public void insertBatch(List<MetricSample> samples, OffsetDateTime ts) {
        for (MetricSample sample : samples) {
            jdbcClient.sql("""
                INSERT INTO public.dsh_metrics_sample (metric, statistic, value, ts)
                VALUES (:metric, :statistic, :value, :ts)
                """)
                .param("metric", sample.metric())
                .param("statistic", sample.statistic())
                .param("value", sample.value())
                .param("ts", ts)
                .update();
        }
    }

    /** 单指标时间序列(折线图;按时间升序)。 */
    public List<SeriesPoint> series(String metric, String statistic,
                                    OffsetDateTime from, OffsetDateTime to) {
        return jdbcClient.sql("""
                SELECT ts, value FROM public.dsh_metrics_sample
                WHERE metric = :metric AND statistic = :statistic AND ts BETWEEN :from AND :to
                ORDER BY ts ASC
                """)
            .param("metric", metric)
            .param("statistic", statistic)
            .param("from", from)
            .param("to", to)
            .query((rs, rowNum) -> new SeriesPoint(
                rs.getObject("ts", OffsetDateTime.class), rs.getDouble("value")))
            .list();
    }

    /**
     * 多指标各自最新 VALUE(实时卡片;DISTINCT ON 是 PostgreSQL 特有,本服务只连 PG)。
     */
    public Map<String, Double> latestValues(List<String> metrics) {
        return jdbcClient.sql("""
                SELECT DISTINCT ON (metric) metric, value
                FROM public.dsh_metrics_sample
                WHERE statistic = 'VALUE' AND metric = ANY(:metrics)
                ORDER BY metric, ts DESC
                """)
            .param("metrics", metrics)
            .query((rs, rowNum) -> Map.entry(rs.getString("metric"), rs.getDouble("value")))
            .list()
            .stream()
            .collect(HashMap::new, (m, e) -> m.put(e.getKey(), e.getValue()), HashMap::putAll);
    }

    /**
     * 窗口内的原始采样行(差分计算数据源;按时间升序)。
     */
    public List<MetricRow> rowsSince(List<String> metrics, OffsetDateTime from) {
        return jdbcClient.sql("""
                SELECT metric, statistic, value, ts FROM public.dsh_metrics_sample
                WHERE metric = ANY(:metrics) AND ts >= :from
                ORDER BY ts ASC
                """)
            .param("metrics", metrics)
            .param("from", from)
            .query((rs, rowNum) -> new MetricRow(
                rs.getString("metric"), rs.getString("statistic"),
                rs.getDouble("value"), rs.getObject("ts", OffsetDateTime.class)))
            .list();
    }

    /** 删除过期指标行,返回删除行数(每日清理调度用)。 */
    public int deleteOlderThan(OffsetDateTime cutoff) {
        return jdbcClient.sql("DELETE FROM public.dsh_metrics_sample WHERE ts < :cutoff")
            .param("cutoff", cutoff)
            .update();
    }

    /**
     * 同一指标最近一次告警审计事件时间(2 小时去重窗口用);无历史告警返回 null。
     *
     * <p>直接查 {@code public.audit_events}(与治理数据同 schema):告警事件类型
     * {@code ANALYTICS_ALERT},metric 名存 details JSONB 的 {@code metric} 字段。
     * 事件写入统一走 {@link com.dsh.console.audit.AuditService},本表不写审计。
     */
    public OffsetDateTime lastAlertAt(String metric) {
        return jdbcClient.sql("""
                SELECT MAX(created_at) AS last_at FROM public.audit_events
                WHERE event_type = :eventType AND details->>'metric' = :metric
                """)
            .param("eventType", MetricsPoller.ALERT_EVENT_TYPE)
            .param("metric", metric)
            .query((rs, rowNum) -> rs.getObject("last_at", OffsetDateTime.class))
            .optional()
            .orElse(null);
    }
}
