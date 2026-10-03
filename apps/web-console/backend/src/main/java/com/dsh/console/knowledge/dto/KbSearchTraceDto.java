package com.dsh.console.knowledge.dto;

import java.util.List;
import java.util.UUID;

/**
 * 混合检索 debug 追踪(web console「知识库」检索可视化页面专用):
 * 一次查询的三路候选明细、文档级 RRF 融合明细、rerank 精排明细与最终命中,字段语义与
 * kb-hybrid-search-design.md 一致。每调用一次真实执行一次查询向量化(硅基流动)。
 *
 * @param kbId           知识库 id
 * @param query          查询文本
 * @param folderId       限定的文件夹(null = 全库)
 * @param topK           收敛后的返回条数(1~50,缺省 8)
 * @param candidateLimit 每路候选上限(3 × topK)
 * @param rerankMinScore rerank 采纳阈值(低于阈值的候选被过滤)
 * @param rerankModel    rerank 模型名(展示用)
 * @param paths          三路候选明细(顺序固定:向量 → 关键词 → 全文)
 * @param rerankPool     RRF 融合后的候选池(2×topK,含重排分与是否入选;重排分为
 *                       null 表示本次 rerank 调用失败降级)
 * @param docs           出现在任意一路的文档聚合明细(按 RRF 总分降序,同分按首次出现序)
 * @param results        最终命中(与 search 端点响应完全一致)
 */
public record KbSearchTraceDto(
    UUID kbId,
    String query,
    UUID folderId,
    int topK,
    int candidateLimit,
    double rerankMinScore,
    String rerankModel,
    List<KbTracePathDto> paths,
    List<KbTraceRerankDto> rerankPool,
    List<KbTraceDocDto> docs,
    List<KbSearchHitDto> results
) {

    /** 路径机器名:向量路。 */
    public static final String PATH_VECTOR = "vector";
    /** 路径机器名:关键词路(pg_trgm)。 */
    public static final String PATH_KEYWORD = "keyword";
    /** 路径机器名:全文路(jiebacfg)。 */
    public static final String PATH_FTS = "fts";
}
