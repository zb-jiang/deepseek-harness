package com.dsh.console.knowledge.dto;

import java.util.List;
import java.util.UUID;

/**
 * 文档级 RRF 融合明细(search-debug;出现在任意一路的文档都有一行,不只 topK)。
 *
 * @param docId         文档 id
 * @param docName       文档名
 * @param folderId      所在文件夹(null = 根)
 * @param totalScore    RRF 总分(全部贡献分之和;仅本次查询内可比)
 * @param finalRank     融合后名次(1 起,按总分降序、同分按首次出现序)
 * @param inTopK        是否进入最终 topK
 * @param contributions 全部贡献明细(按累加顺序:路序固定,路内名次升序)
 */
public record KbTraceDocDto(
    UUID docId,
    String docName,
    UUID folderId,
    double totalScore,
    int finalRank,
    boolean inTopK,
    List<KbTraceContributionDto> contributions
) {
}
