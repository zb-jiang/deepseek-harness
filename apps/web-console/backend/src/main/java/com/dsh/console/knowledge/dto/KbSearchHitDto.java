package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 文档级混合检索命中(kb_search 查询管线;三路候选统一按文档聚合,同文档只出现一条)。
 *
 * @param docId    文档 id(衔接 kb_read)
 * @param docName  文档名
 * @param folderId 所在文件夹(null = 根)
 * @param snippet  原文摘录:文档 text_content 前 1000 字符在前,该文档有向量命中时
 *                 追加名次最优块(换行拼接)
 * @param score    相关性分:正常为 rerank 重排分(0~1,越大越相关);本次 rerank 调用
 *                 失败降级时为 RRF 融合分(仅本次结果内可比)
 */
public record KbSearchHitDto(
    UUID docId,
    String docName,
    UUID folderId,
    String snippet,
    double score
) {
}
