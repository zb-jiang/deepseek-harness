package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.console.knowledge.dto.KbSearchHitDto;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@link KnowledgeService#applyRerank} 纯函数:rerank 采纳规则——低于阈值过滤、
 * 按重排分降序、截前 topK、score 替换为重排分;过阈值不足 topK 时返回全部过阈值者。
 */
class KnowledgeServiceRerankTest {

    private static final UUID DOC_A = UUID.randomUUID();
    private static final UUID DOC_B = UUID.randomUUID();
    private static final UUID DOC_C = UUID.randomUUID();

    private static KbSearchHitDto hit(UUID docId, String name, double rrfScore) {
        return new KbSearchHitDto(docId, name, null, "snippet-" + name, rrfScore);
    }

    @Test
    void filtersBelowThresholdSortsByRerankScoreAndReplacesScore() {
        // RRF 序 A>B>C;重排分 B 最高、C 被阈值过滤、A 居中
        List<KbSearchHitDto> pool = List.of(hit(DOC_A, "A", 0.05), hit(DOC_B, "B", 0.03), hit(DOC_C, "C", 0.02));
        List<KbSearchHitDto> results =
            KnowledgeService.applyRerank(pool, List.of(0.5, 0.95, 0.05), 0.1, 8);

        assertThat(results).extracting(KbSearchHitDto::docName).containsExactly("B", "A");
        // score 替换为重排分(snippet 等其余字段保留)
        assertThat(results).extracting(KbSearchHitDto::score).containsExactly(0.95, 0.5);
        assertThat(results.get(0).snippet()).isEqualTo("snippet-B");
    }

    @Test
    void allBelowThresholdYieldsEmptyResults() {
        // 全部低于阈值 → 空结果(与词法两路零命中语义一致)
        List<KbSearchHitDto> pool = List.of(hit(DOC_A, "A", 0.05), hit(DOC_B, "B", 0.03));
        assertThat(KnowledgeService.applyRerank(pool, List.of(0.001, 0.002), 0.1, 8)).isEmpty();
    }

    @Test
    void returnsAllSurvivorsWhenTopKNotExhausted() {
        // 过阈值的不足 topK → 返回全部过阈值者,不补低分候选
        List<KbSearchHitDto> pool = List.of(hit(DOC_A, "A", 0.05), hit(DOC_B, "B", 0.03));
        List<KbSearchHitDto> results = KnowledgeService.applyRerank(pool, List.of(0.8, 0.02), 0.1, 8);

        assertThat(results).extracting(KbSearchHitDto::docName).containsExactly("A");
    }

    @Test
    void capsAtTopKAndKeepsPoolOrderOnTie() {
        List<KbSearchHitDto> pool = List.of(
            hit(DOC_A, "A", 0.05), hit(DOC_B, "B", 0.04), hit(DOC_C, "C", 0.03));
        // 同分时保持池序(RRF 序)稳定排序,且只取前 topK
        List<KbSearchHitDto> results = KnowledgeService.applyRerank(pool, List.of(0.7, 0.7, 0.7), 0.1, 2);

        assertThat(results).extracting(KbSearchHitDto::docName).containsExactly("A", "B");
    }
}
