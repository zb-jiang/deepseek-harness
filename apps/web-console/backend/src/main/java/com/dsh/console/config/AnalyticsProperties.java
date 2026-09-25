package com.dsh.console.config;

import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 分析看板配置(设计 2026-09-25 §8,前缀 {@code dsh.analytics})。
 *
 * <p>默认值内置(未配置时生效);application.yml 可用环境变量覆盖
 * ({@code ANALYTICS_POLL_INTERVAL_MS} / {@code ANALYTICS_RETENTION_DAYS})。
 */
@ConfigurationProperties(prefix = "dsh.analytics")
public class AnalyticsProperties {

    /** 引擎 /actuator/metrics 轮询间隔(毫秒)。 */
    private long pollIntervalMs = 30_000;

    /** dsh_metrics_sample 指标保留天数(每日 03:30 清理过期行)。 */
    private int retentionDays = 90;

    /** 轮询白名单(引擎 actuator metrics 指标名;白名单外不采集)。 */
    private List<String> metrics = List.of(
        "dsh.flowable.jobs.async",
        "dsh.flowable.jobs.timer",
        "dsh.flowable.jobs.deadletter",
        "dsh.flowable.jobs.suspended",
        "dsh.backend.task",
        "dsh.task.escalation",
        "hikaricp.connections.active",
        "jvm.memory.used");

    /**
     * 简单阈值告警:指标名 → max 阈值。轮询后指标 VALUE 越限写
     * {@code ANALYTICS_ALERT} 审计事件(同一指标 2 小时去重)。
     */
    private Map<String, Double> alerts = Map.of();

    public long getPollIntervalMs() {
        return pollIntervalMs;
    }

    public void setPollIntervalMs(long pollIntervalMs) {
        this.pollIntervalMs = pollIntervalMs;
    }

    public int getRetentionDays() {
        return retentionDays;
    }

    public void setRetentionDays(int retentionDays) {
        this.retentionDays = retentionDays;
    }

    public List<String> getMetrics() {
        return metrics;
    }

    public void setMetrics(List<String> metrics) {
        this.metrics = metrics;
    }

    public Map<String, Double> getAlerts() {
        return alerts;
    }

    public void setAlerts(Map<String, Double> alerts) {
        this.alerts = alerts;
    }
}
