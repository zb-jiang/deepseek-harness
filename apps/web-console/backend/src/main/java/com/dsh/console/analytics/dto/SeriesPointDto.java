package com.dsh.console.analytics.dto;

import java.time.OffsetDateTime;

/**
 * 运维指标时间序列点(运维健康 tab 趋势折线)。
 *
 * @param ts    采样时间
 * @param value 采样值(statistic 指定的口径:VALUE/COUNT/TOTAL_TIME/MAX)
 */
public record SeriesPointDto(
    OffsetDateTime ts,
    double value
) {
}
