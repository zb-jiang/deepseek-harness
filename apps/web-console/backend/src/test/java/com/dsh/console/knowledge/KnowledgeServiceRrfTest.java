package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.console.knowledge.dto.KbSearchHitDto;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@link KnowledgeService#rrfMerge} 纯函数:三路候选按 docId 聚合的 RRF 融合排序、
 * 跨路/跨块分数累加、snippet 选优(向量块文本优先)与截断、topK 截断。
 */
class KnowledgeServiceRrfTest {

    private static final UUID DOC_A = UUID.randomUUID();
    private static final UUID DOC_B = UUID.randomUUID();
    private static final UUID DOC_C = UUID.randomUUID();

    /** 文档级候选(关键词/全文两路的行;snippet 为抽取全文)。 */
    private static KbSearchCandidate doc(UUID docId, String name, String snippet) {
        return new KbSearchCandidate(docId, name, null, snippet, null, null);
    }

    /** 向量路 chunk 行(服务层聚合前的原始粒度;snippet 为块文本)。 */
    private static KbSearchCandidate chunk(UUID docId, String name, String snippet) {
        return new KbSearchCandidate(docId, name, null, snippet, null, null);
    }

    @Test
    void accumulatesScoreWhenSameDocHitsMultipleRoutes() {
        // 同一文档:keyword 路 rank1(1/61)+ fts 路 rank2(1/62),聚合为一条且分数累加
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(
            List.of(),
            List.of(doc(DOC_A, "报销标准", "全文 A")),
            List.of(doc(DOC_B, "差旅制度", "全文 B"), doc(DOC_A, "报销标准", "全文 A")),
            8);

        assertThat(merged).hasSize(2);
        assertThat(merged.get(0).docId()).isEqualTo(DOC_A);
        assertThat(merged.get(0).score())
            .isEqualTo(1.0 / (KnowledgeService.RRF_K + 1) + 1.0 / (KnowledgeService.RRF_K + 2));
        // 单路命中的文档分数为 1/(k + rank)
        assertThat(merged.get(1).docId()).isEqualTo(DOC_B);
        assertThat(merged.get(1).score()).isEqualTo(1.0 / (KnowledgeService.RRF_K + 1));
    }

    @Test
    void aggregatesVectorChunksOfSameDocIntoOneHitWithAccumulatedScore() {
        // 向量路同文档多块:chunk1 rank2(1/62)+ chunk2 rank5(1/65)累加后反超 rank1 的单块文档
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(
            List.of(
                chunk(DOC_B, "单块文档", "B 的块"),
                chunk(DOC_A, "长文档", "A 的最优块"),
                chunk(UUID.randomUUID(), "无关文档", "C 的块"),
                chunk(UUID.randomUUID(), "无关文档", "D 的块"),
                chunk(DOC_A, "长文档", "A 的次优块")),
            List.of(),
            List.of(),
            8);

        assertThat(merged).hasSize(4);
        assertThat(merged.get(0).docId()).isEqualTo(DOC_A);
        assertThat(merged.get(0).score())
            .isEqualTo(1.0 / (KnowledgeService.RRF_K + 2) + 1.0 / (KnowledgeService.RRF_K + 5));
        assertThat(merged.get(1).docId()).isEqualTo(DOC_B);
    }

    @Test
    void snippetPrefersBestVectorChunkOverLexicalExcerpt() {
        // 向量命中:snippet 取名次最优块文本(rank1 的「住宿标准」,不是 rank2 的次优块,
        // 也不是关键词路的抽取全文);纯词法命中的 DOC_B:无向量块,退回抽取全文
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(
            List.of(
                chunk(DOC_A, "报销标准", "住宿标准"),
                chunk(DOC_A, "报销标准", "无关开头")),
            List.of(doc(DOC_A, "报销标准", "文档开头摘录"), doc(DOC_B, "差旅制度", "差旅制度全文")),
            List.of(),
            8);

        assertThat(merged).hasSize(2);
        assertThat(merged.get(0).docId()).isEqualTo(DOC_A);
        assertThat(merged.get(0).snippet()).isEqualTo("住宿标准");
        assertThat(merged.get(1).snippet()).isEqualTo("差旅制度全文");
    }

    @Test
    void ranksByAccumulatedScoreAndKeepsStableOrderOnTie() {
        // B 跨两路累加居首;A 与 C 同为 1/61,按插入顺序(vector 路先于 fts 路)稳定排序
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(
            List.of(chunk(DOC_A, "A", "块 A")),
            List.of(chunk(DOC_B, "B", "块 B")),
            List.of(chunk(DOC_C, "C", "块 C"), chunk(DOC_B, "B", "块 B")),
            8);

        assertThat(merged).extracting(KbSearchHitDto::docName)
            .containsExactly("B", "A", "C");
    }

    @Test
    void truncatesLongSnippetWithEllipsis() {
        String longText = "字".repeat(400);
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(
            List.of(chunk(DOC_A, "长文", longText)),
            List.of(),
            List.of(),
            8);

        String snippet = merged.get(0).snippet();
        assertThat(snippet).hasSize(301);
        assertThat(snippet).startsWith("字".repeat(300));
        assertThat(snippet).endsWith("…");
    }

    @Test
    void truncatesToTopKKeepingHighestScores() {
        List<KbSearchCandidate> vector = List.of(
            chunk(DOC_A, "A", "块 A"),
            chunk(DOC_B, "B", "块 B"),
            chunk(DOC_C, "C", "块 C"),
            chunk(UUID.randomUUID(), "D", "块 D"),
            chunk(UUID.randomUUID(), "E", "块 E"));
        List<KbSearchHitDto> merged = KnowledgeService.rrfMerge(vector, List.of(), List.of(), 2);

        assertThat(merged).extracting(KbSearchHitDto::docName).containsExactly("A", "B");
    }

    @Test
    void emptyRoutesProduceNoHits() {
        assertThat(KnowledgeService.rrfMerge(List.of(), List.of(), List.of(), 8)).isEmpty();
    }
}
