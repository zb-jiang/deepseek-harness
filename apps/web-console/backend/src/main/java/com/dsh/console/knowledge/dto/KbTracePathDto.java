package com.dsh.console.knowledge.dto;

import java.util.List;

/**
 * 单路候选明细(search-debug;候选按路内名次升序,rank 从 1 起)。
 *
 * @param path       路径机器名({@code KbSearchTraceDto.PATH_*} 常量)
 * @param metric     路内原始分语义说明(面向调试者展示)
 * @param candidates 该路全部候选(上限 3 × topK)
 */
public record KbTracePathDto(
    String path,
    String metric,
    List<KbTraceCandidateDto> candidates
) {
}
