package com.dsh.flowable.api;

/**
 * 流程实例概览统计 DTO(分析看板「业务分析」tab 概览卡片)。
 *
 * <p>数据来源:引擎 {@code ACT_HI_PROCINST} 按时间窗聚合,聚合下推 PG(percentile_cont)。
 * 统计口径:时间窗按 {@code START_TIME_} 过滤(发起时间在窗口内的实例);
 * completed = 正常完成(END_TIME_ 非空且 DELETE_REASON_ 为空);
 * terminated = 已终止(END_TIME_ 非空且 DELETE_REASON_ 非空,管理员干预或流程级 cancel);
 * running = 窗口内发起且尚未结束(END_TIME_ 为空)。
 *
 * @param started        窗口内发起的实例总数
 * @param completed      正常完成数
 * @param running        运行中数
 * @param terminated     已终止数
 * @param avgDurationMs  已结束实例的平均端到端时长(毫秒);无已结束实例时为 null
 * @param p95DurationMs  已结束实例端到端时长 P95(毫秒);无已结束实例时为 null
 */
public record AnalyticsOverviewDto(
    long started,
    long completed,
    long running,
    long terminated,
    Long avgDurationMs,
    Long p95DurationMs
) {
}
