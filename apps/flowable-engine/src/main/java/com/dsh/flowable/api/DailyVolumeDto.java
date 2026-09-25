package com.dsh.flowable.api;

/**
 * 每日流程吞吐量 DTO(分析看板吞吐趋势折线)。
 *
 * <p>started 按实例发起日({@code START_TIME_} 日期)聚合,completed 按实例完成日
 * ({@code END_TIME_} 日期)聚合、只统计正常完成(排除已终止);两个维度经
 * FULL OUTER JOIN 合并在同一日期轴上,某日只发起未完成时 completed 为 0,反之亦然。
 *
 * @param date      日期(ISO 8601,yyyy-MM-dd)
 * @param started   当日发起的实例数
 * @param completed 当日正常完成的实例数
 */
public record DailyVolumeDto(
    String date,
    long started,
    long completed
) {
}
