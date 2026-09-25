package com.dsh.console.analytics;

import com.dsh.console.analytics.MetricsJdbcRepository.MetricSample;
import com.dsh.console.audit.AuditService;
import com.dsh.console.config.AnalyticsProperties;
import com.dsh.console.runtime.FlowableRestClient;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 引擎运维指标轮询采集(分析看板「运维健康」tab 的数据管道,设计 2026-09-25 §8.2)。
 *
 * <p>定时(默认 30s)调引擎 {@code GET /actuator/metrics/{metric}}(permitAll,内网信任;
 * 调度线程无用户 JWT,透传 interceptor 不补头——见 {@code RestClientConfig} 线程边界说明),
 * 把白名单指标的 measurements 逐 statistic 拆行批量插入 {@code dsh_metrics_sample}。
 * 单指标失败仅 WARN、下轮重试(不补采历史空洞,V1 从简)。
 *
 * <p>带 tag 的指标(Timer 如 {@code dsh.backend.task} 有 outcome tag):按引擎返回的
 * {@code availableTags} 第一个 tag 逐值展开采集,落库名形如
 * {@code dsh.backend.task{outcome=success}}——成功率/时延差分按这两个名字取数。
 * 只展开第一个 tag(V1 白名单内只有 outcome 一个 tag 维度)。
 *
 * <p>附带两个调度:每日 03:30 过期清理(保留期可配);轮询后阈值告警检查
 * (VALUE 越限 → {@code ANALYTICS_ALERT} 审计事件,同一指标 2 小时去重;无通知渠道)。
 */
@Component
public class MetricsPoller {

    private static final Logger log = LoggerFactory.getLogger(MetricsPoller.class);

    /** 阈值告警审计事件类型(audit_events.event_type;details.metric 存指标名)。 */
    public static final String ALERT_EVENT_TYPE = "ANALYTICS_ALERT";

    /** 同一指标告警去重窗口。 */
    private static final Duration ALERT_DEDUP_WINDOW = Duration.ofHours(2);

    private final FlowableRestClient flowableRestClient;
    private final MetricsJdbcRepository repository;
    private final AuditService auditService;
    private final AnalyticsProperties properties;

    public MetricsPoller(FlowableRestClient flowableRestClient,
                         MetricsJdbcRepository repository,
                         AuditService auditService,
                         AnalyticsProperties properties) {
        this.flowableRestClient = flowableRestClient;
        this.repository = repository;
        this.auditService = auditService;
        this.properties = properties;
    }

    /**
     * 轮询白名单指标并落库。
     */
    @Scheduled(fixedDelayString = "${dsh.analytics.poll-interval-ms:30000}")
    public void poll() {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        for (String metric : properties.getMetrics()) {
            try {
                pollMetric(metric, now);
            } catch (RuntimeException e) {
                log.warn("引擎指标轮询失败,下轮重试: metric={}, cause={}", metric, e.getMessage());
            }
        }
    }

    /**
     * 每日过期清理(保留期 {@code dsh.analytics.retention-days},默认 90 天)。
     */
    @Scheduled(cron = "${dsh.analytics.cleanup-cron:0 30 3 * * *}")
    public void cleanup() {
        int deleted = repository.deleteOlderThan(
            OffsetDateTime.now(ZoneOffset.UTC).minusDays(properties.getRetentionDays()));
        if (deleted > 0) {
            log.info("dsh_metrics_sample 过期清理: 删除 {} 行(保留 {} 天)", deleted,
                properties.getRetentionDays());
        }
    }

    /** 采集单个指标:无 tag 直接落库;有 tag 按第一个 tag 逐值展开。 */
    private void pollMetric(String metric, OffsetDateTime now) {
        JsonNode response = flowableRestClient.getEngineMetric(metric, null);
        if (response == null) {
            return;
        }
        JsonNode availableTags = response.path("availableTags");
        if (availableTags.isArray() && !availableTags.isEmpty()
                && availableTags.get(0).path("values").isArray()
                && !availableTags.get(0).path("values").isEmpty()) {
            String tagKey = availableTags.get(0).path("tag").asText();
            for (JsonNode tagValue : availableTags.get(0).path("values")) {
                String value = tagValue.asText();
                JsonNode tagged = flowableRestClient.getEngineMetric(metric, tagKey + ":" + value);
                List<MetricSample> samples = toSamples(tagged, metric + "{" + tagKey + "=" + value + "}");
                repository.insertBatch(samples, now);
            }
        } else {
            List<MetricSample> samples = toSamples(response, metric);
            repository.insertBatch(samples, now);
        }
        checkAlert(metric, response);
    }

    /** measurements[] 逐 statistic 拆行;空/异常响应返回空列表(本轮无数据)。 */
    private List<MetricSample> toSamples(JsonNode response, String storedName) {
        List<MetricSample> samples = new ArrayList<>();
        if (response == null) {
            return samples;
        }
        for (JsonNode measurement : response.path("measurements")) {
            if (measurement.has("statistic") && measurement.has("value")) {
                samples.add(new MetricSample(storedName,
                    measurement.path("statistic").asText(),
                    measurement.path("value").asDouble()));
            }
        }
        return samples;
    }

    /**
     * 阈值告警检查:配置了 max 阈值且本轮 VALUE 越限(> 阈值)时写审计事件;
     * 同一指标 2 小时内不重复(查最近告警审计事件时间)。
     */
    private void checkAlert(String metric, JsonNode response) {
        Double threshold = properties.getAlerts().get(metric);
        if (threshold == null) {
            return;
        }
        Double latestValue = findValueStatistic(response);
        if (latestValue == null || latestValue <= threshold) {
            return;
        }
        OffsetDateTime lastAlert = repository.lastAlertAt(metric);
        if (lastAlert != null && lastAlert.isAfter(
                OffsetDateTime.now(ZoneOffset.UTC).minus(ALERT_DEDUP_WINDOW))) {
            return;
        }
        log.warn("引擎指标越限: metric={}, value={}, threshold={}", metric, latestValue, threshold);
        auditService.record(ALERT_EVENT_TYPE, "engine_metric", null, null,
            Map.of("metric", metric, "value", latestValue, "threshold", threshold, "rule", "max"));
    }

    /** 取响应 measurements 里 VALUE statistic 的值(告警只看瞬时值);缺省返回 null。 */
    private Double findValueStatistic(JsonNode response) {
        for (JsonNode measurement : response.path("measurements")) {
            if ("VALUE".equals(measurement.path("statistic").asText())) {
                return measurement.path("value").asDouble();
            }
        }
        return null;
    }
}
