package com.dsh.console.knowledge.dto;

import java.util.List;

/**
 * 单条 RRF 贡献明细(search-debug;每条候选行贡献一次)。
 *
 * @param path  路径机器名({@code KbSearchTraceDto.PATH_*} 常量)
 * @param rank  路内名次(1 起)
 * @param score 贡献分 1/(k+rank),k=60
 */
public record KbTraceContributionDto(
    String path,
    int rank,
    double score
) {
}
