package com.dsh.console.knowledge;

import java.util.UUID;

/**
 * 混合检索候选行(三路共用,统一文档粒度)。
 *
 * <p>向量路返回的是 chunk 行,由 {@code KnowledgeService#rrfMerge} 按 docId 聚合为
 * 文档级候选;聚合后同文档只保留一条,聚合候选的 snippet 取该文档在向量路名次最优的块文本。
 *
 * <p>rawScore 是路内原始分(排序依据,RRF 融合只用名次不用分值),search-debug
 * 端点用于展示各路打分明细;普通检索输出不携带。三种路的语义不同:向量路为
 * 余弦距离(越小越近),关键词路为 pg_trgm 相似度(0~1),全文路为 ts_rank。
 *
 * @param docId      文档 id
 * @param docName    文档名
 * @param folderId   所在文件夹(null = 根)
 * @param snippet    命中文本(向量路为 chunk 原文;词法两路为文档 text_content 前 1000 字符)
 * @param chunkIndex 块下标(仅向量路;词法两路为 null)
 * @param rawScore   路内原始排序分(语义随路不同,见类注释;text_content 为 NULL 时关键词路可能为 null)
 */
record KbSearchCandidate(
    UUID docId,
    String docName,
    UUID folderId,
    String snippet,
    Integer chunkIndex,
    Double rawScore
) {
}
