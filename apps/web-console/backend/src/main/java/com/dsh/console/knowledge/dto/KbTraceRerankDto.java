package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * rerank 泳道候选行(debug 追踪):RRF 候选池(2×topK)中每篇文档的融合分与重排分。
 *
 * @param docId      文档 id
 * @param docName    文档名
 * @param rrfScore   RRF 融合分(Σ 1/(60+名次),进池顺序按此降序)
 * @param rerankScore 重排相关性分(0~1,越大越相关;null = rerank 关闭或失败降级)
 * @param inTopK     是否进入最终 topK(rerank 启用时 = 重排分过阈值且排进前 topK;
 *                   降级时 = RRF 序前 topK)
 */
public record KbTraceRerankDto(
    UUID docId,
    String docName,
    double rrfScore,
    Double rerankScore,
    boolean inTopK
) {
}
