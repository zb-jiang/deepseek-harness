package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 单路单个候选(search-debug;向量路为 chunk 行,词法两路为文档行)。
 *
 * @param docId    文档 id
 * @param docName  文档名
 * @param folderId 所在文件夹(null = 根)
 * @param rank     路内名次(1 起,与 RRF 计分名次一致)
 * @param rawScore 路内原始排序分(语义随路不同:向量=余弦距离/关键词=trgm 相似度/全文=ts_rank)
 * @param chunkIndex 块下标(仅向量路;词法两路为 null)
 * @param rrfScore 该行向所属文档贡献的 RRF 分(1/(k+rank),k=60)
 * @param snippet  命中文本(向量路为 chunk 原文;词法两路为文档 text_content 前 1000 字符)
 */
public record KbTraceCandidateDto(
    UUID docId,
    String docName,
    UUID folderId,
    int rank,
    Double rawScore,
    Integer chunkIndex,
    double rrfScore,
    String snippet
) {
}
