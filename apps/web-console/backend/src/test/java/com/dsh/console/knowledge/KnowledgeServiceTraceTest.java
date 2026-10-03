package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.console.knowledge.dto.KbSearchTraceDto;
import com.dsh.console.knowledge.dto.KbTraceContributionDto;
import com.dsh.console.knowledge.dto.KbTraceDocDto;
import com.dsh.console.knowledge.dto.KbTraceRerankDto;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@link KnowledgeService} 纯函数:{@code buildTrace} 的 debug 追踪三路名次与 RRF 贡献、
 * 文档级跨路/跨块累加、排序与 results 一致、inTopK 标记;{@code composeSnippet} 的
 * 最终输出 snippet 组合规则。
 */
class KnowledgeServiceTraceTest {

    private static final UUID DOC_A = UUID.randomUUID();
    private static final UUID DOC_B = UUID.randomUUID();
    private static final UUID DOC_C = UUID.randomUUID();
    private static final int K = KnowledgeService.RRF_K;

    private static KbSearchCandidate doc(UUID docId, String name, String snippet, Double rawScore) {
        return new KbSearchCandidate(docId, name, null, snippet, null, rawScore);
    }

    private static KbSearchCandidate chunk(UUID docId, String name, String snippet, int chunkIndex, Double rawScore) {
        return new KbSearchCandidate(docId, name, null, snippet, chunkIndex, rawScore);
    }

    @Test
    void pathsCarryRankRawScoreAndRrfContribution() {
        KnowledgeService.SearchRun run = new KnowledgeService.SearchRun(
            8, 24, 0.55, 0.1, "Qwen/Qwen3-Reranker-8B",
            List.of(chunk(DOC_A, "报销标准", "住宿标准", 2, 0.11)),
            List.of(doc(DOC_B, "差旅制度", "全文 B", 0.42)),
            List.of(),
            List.of(),
            List.of());
        KbSearchTraceDto trace = KnowledgeService.buildTrace(UUID.randomUUID(), "报销", null, run);

        assertThat(trace.paths()).hasSize(3);
        assertThat(trace.paths().get(0).path()).isEqualTo(KbSearchTraceDto.PATH_VECTOR);
        // 向量路 metric 带距离阈值:超阈值的块在 SQL 层已过滤
        assertThat(trace.paths().get(0).metric()).isEqualTo("余弦距离(≤ 0.55,越小越相关)");
        assertThat(trace.paths().get(0).candidates()).hasSize(1);
        assertThat(trace.paths().get(0).candidates().get(0).rank()).isEqualTo(1);
        assertThat(trace.paths().get(0).candidates().get(0).chunkIndex()).isEqualTo(2);
        assertThat(trace.paths().get(0).candidates().get(0).rawScore()).isEqualTo(0.11);
        assertThat(trace.paths().get(0).candidates().get(0).rrfScore()).isEqualTo(1.0 / (K + 1));
        // 词法路无 chunkIndex;空路不产生候选
        assertThat(trace.paths().get(1).path()).isEqualTo(KbSearchTraceDto.PATH_KEYWORD);
        assertThat(trace.paths().get(1).candidates().get(0).chunkIndex()).isNull();
        assertThat(trace.paths().get(1).candidates().get(0).rrfScore()).isEqualTo(1.0 / (K + 1));
        assertThat(trace.paths().get(2).path()).isEqualTo(KbSearchTraceDto.PATH_FTS);
        assertThat(trace.paths().get(2).candidates()).isEmpty();
    }

    @Test
    void docsAccumulateContributionsAcrossRoutesAndChunks() {
        // DOC_A:向量路两块(rank2、rank5,中间隔两个无关块)+ 关键词路 rank1;DOC_B:向量路 rank1
        KnowledgeService.SearchRun run = new KnowledgeService.SearchRun(
            8, 24, 0.55, 0.1, "Qwen/Qwen3-Reranker-8B",
            List.of(
                chunk(DOC_B, "单块文档", "B 块", 0, 0.05),
                chunk(DOC_A, "长文档", "A 最优块", 3, 0.09),
                chunk(UUID.randomUUID(), "无关文档", "C 块", 0, 0.30),
                chunk(UUID.randomUUID(), "无关文档", "D 块", 0, 0.40),
                chunk(DOC_A, "长文档", "A 次块", 7, 0.21)),
            List.of(doc(DOC_A, "长文档", "全文 A", 0.6)),
            List.of(),
            List.of(),
            List.of());
        KbSearchTraceDto trace = KnowledgeService.buildTrace(UUID.randomUUID(), "报销", null, run);

        assertThat(trace.docs()).hasSize(4);
        // DOC_A 总分 1/(k+2)+1/(k+5)+1/(k+1) 反超 DOC_B 的 1/(k+1),居首
        KbTraceDocDto first = trace.docs().get(0);
        assertThat(first.docId()).isEqualTo(DOC_A);
        assertThat(first.finalRank()).isEqualTo(1);
        assertThat(first.totalScore())
            .isEqualTo(1.0 / (K + 2) + 1.0 / (K + 5) + 1.0 / (K + 1));
        assertThat(first.contributions()).extracting(KbTraceContributionDto::path)
            .containsExactly(KbSearchTraceDto.PATH_VECTOR, KbSearchTraceDto.PATH_VECTOR, KbSearchTraceDto.PATH_KEYWORD);
        assertThat(first.contributions()).extracting(KbTraceContributionDto::rank)
            .containsExactly(2, 5, 1);
        // DOC_B 向量路 rank1,排序第二;两个无关块文档落在其后
        assertThat(trace.docs().get(1).docId()).isEqualTo(DOC_B);
        assertThat(trace.docs().get(1).finalRank()).isEqualTo(2);
    }

    @Test
    void docsOutsideTopKAreFlaggedNotFiltered() {
        List<KbSearchCandidate> vector = List.of(
            chunk(DOC_A, "A", "块 A", 0, 0.1),
            chunk(DOC_B, "B", "块 B", 0, 0.2),
            chunk(DOC_C, "C", "块 C", 0, 0.3));
        // results 与生产一致:由 rrfMerge 对同一批候选产出
        KnowledgeService.SearchRun run = new KnowledgeService.SearchRun(
            2, 6, 0.55, 0.1, "Qwen/Qwen3-Reranker-8B", vector, List.of(), List.of(),
            List.of(new KbTraceRerankDto(DOC_A, "A", 1.0 / (K + 1), 0.9, true)),
            KnowledgeService.rrfMerge(vector, List.of(), List.of(), 2));
        KbSearchTraceDto trace = KnowledgeService.buildTrace(UUID.randomUUID(), "查询", null, run);

        assertThat(trace.topK()).isEqualTo(2);
        assertThat(trace.docs()).hasSize(3);
        assertThat(trace.docs()).extracting(KbTraceDocDto::inTopK).containsExactly(true, true, false);
        // topK=2 时 results 只有 2 条,docs 保留全部 3 条供调试
        assertThat(trace.results()).hasSize(2);
        assertThat(trace.candidateLimit()).isEqualTo(6);
        // rerank 配置与候选池逐行透传,供 debug 页渲染精排泳道
        assertThat(trace.rerankMinScore()).isEqualTo(0.1);
        assertThat(trace.rerankModel()).isEqualTo("Qwen/Qwen3-Reranker-8B");
        assertThat(trace.rerankPool()).hasSize(1);
        assertThat(trace.rerankPool().get(0).docId()).isEqualTo(DOC_A);
        assertThat(trace.rerankPool().get(0).rerankScore()).isEqualTo(0.9);
        assertThat(trace.rerankPool().get(0).inTopK()).isTrue();
    }

    @Test
    void docOrderMatchesResultsOrder() {
        List<KbSearchCandidate> vector = List.of(chunk(DOC_A, "A", "块 A", 0, 0.1));
        List<KbSearchCandidate> keyword = List.of(doc(DOC_B, "B", "全文 B", 0.5));
        List<KbSearchCandidate> fts = List.of(doc(DOC_B, "B", "全文 B", 0.3), doc(DOC_A, "A", "全文 A", 0.2));
        // results 与生产一致:由 rrfMerge 对同一批候选产出
        KnowledgeService.SearchRun run = new KnowledgeService.SearchRun(
            8, 24, 0.55, 0.1, "Qwen/Qwen3-Reranker-8B", vector, keyword, fts, List.of(),
            KnowledgeService.rrfMerge(vector, keyword, fts, 8));
        KbSearchTraceDto trace = KnowledgeService.buildTrace(UUID.randomUUID(), "查询", null, run);

        // B 跨两路累加居首;docs 顺序与 results 顺序完全一致
        assertThat(trace.docs()).extracting(KbTraceDocDto::docName).containsExactly("B", "A");
        assertThat(trace.results()).extracting(result -> result.docName()).containsExactly("B", "A");
        // results 的分数与 docs 的 totalScore 逐条相等
        for (int i = 0; i < trace.results().size(); i++) {
            assertThat(trace.results().get(i).score()).isEqualTo(trace.docs().get(i).totalScore());
        }
    }

    @Test
    void emptyRoutesProduceEmptyTrace() {
        KnowledgeService.SearchRun run = new KnowledgeService.SearchRun(
            8, 24, 0.55, 0.1, "Qwen/Qwen3-Reranker-8B",
            List.of(), List.of(), List.of(), List.of(), List.of());
        KbSearchTraceDto trace = KnowledgeService.buildTrace(UUID.randomUUID(), "查询", null, run);

        assertThat(trace.paths()).hasSize(3);
        assertThat(trace.docs()).isEmpty();
        assertThat(trace.results()).isEmpty();
    }

    @Test
    void composeSnippetCombinesExcerptAndBestChunk() {
        assertThat(KnowledgeService.composeSnippet("文档开头摘录", "命中的块文本", "兜底"))
            .isEqualTo("文档开头摘录\n命中的块文本");
        // 两侧先 strip 再拼接
        assertThat(KnowledgeService.composeSnippet("  摘录  ", "\n块\n", "兜底"))
            .isEqualTo("摘录\n块");
    }

    @Test
    void composeSnippetTakesTheOtherSideWhenOneIsMissing() {
        // 无向量命中(无名次最优块)→ 只剩文档摘录
        assertThat(KnowledgeService.composeSnippet("文档摘录", null, "兜底")).isEqualTo("文档摘录");
        // 文档摘录缺失(text_content 为空)→ 只剩名次最优块
        assertThat(KnowledgeService.composeSnippet(null, "块文本", "兜底")).isEqualTo("块文本");
    }

    @Test
    void composeSnippetFallsBackWhenBothSidesMissing() {
        // 双缺 → 回退 rrfMerge 的默认 snippet(词法路截断文本)
        assertThat(KnowledgeService.composeSnippet(null, null, "  兜底片段  ")).isEqualTo("兜底片段");
        assertThat(KnowledgeService.composeSnippet("  ", "", "兜底片段")).isEqualTo("兜底片段");
        assertThat(KnowledgeService.composeSnippet(null, null, null)).isEmpty();
    }
}
