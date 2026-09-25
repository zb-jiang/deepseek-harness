package com.dsh.console.analytics.dto;

import java.util.Map;

/**
 * 运维健康汇总(实时卡片数据,设计 2026-09-25 §8.3)。
 *
 * <p>差分口径:COUNT/TOTAL_TIME 是单调累计值,窗口内增量 = 末值 - 首值
 * (轮询间隔 15-30s,1h 窗口约 120 个采样点,差分误差可忽略)。
 *
 * @param latest                各白名单指标最新 VALUE(job 积压/连接池/JVM,实时值)
 * @param backendTaskSuccessRate backend task 近 1h 成功率(success 增量 / 总增量);无样本为 null
 * @param backendTaskCount1h    backend task 近 1h 执行份数(success+failed 增量)
 * @param backendTaskAvgLatencyMs backend task 近 1h 平均时延(TOTAL_TIME 增量 / COUNT 增量);无样本为 null
 * @param escalationCount1h     超时升级近 1h 触发次数(COUNT 增量)
 */
public record OpsSummaryDto(
    Map<String, Double> latest,
    Double backendTaskSuccessRate,
    Long backendTaskCount1h,
    Double backendTaskAvgLatencyMs,
    Long escalationCount1h
) {
    /** 差分数据源指标名(tag 展开后的落库名,见 MetricsPoller)。 */
    public static final String BACKEND_TASK_SUCCESS =
        "dsh.backend.task{outcome=success}";
    public static final String BACKEND_TASK_FAILED =
        "dsh.backend.task{outcome=failed}";
    public static final String ESCALATION = "dsh.task.escalation";
}
