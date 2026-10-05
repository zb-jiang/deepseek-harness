package com.dsh.console.llm;

import com.dsh.console.llm.dto.UsageLedgerEntry;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 用量统计。
 * 业务含义:管理后台"用量分析"页的查询入口;数据全部来自 llm_usage_ledger 主账本,不从 New API 抄数。
 */
@Service
public class LlmAnalyticsService {

    private final LlmLedgerJdbcRepository ledgerRepository;

    public LlmAnalyticsService(LlmLedgerJdbcRepository ledgerRepository) {
        this.ledgerRepository = ledgerRepository;
    }

    /** 账本明细分页;from/to 为 created_at 时间区间,to 为排他上界,均可空。 */
    public List<UsageLedgerEntry> listLedger(OffsetDateTime from, OffsetDateTime to, UUID userId,
                                             UUID modelId, String sourceType, UUID sourceId,
                                             String status, int limit, int offset) {
        return ledgerRepository.listLedger(from, to, userId, modelId, sourceType, sourceId,
            status, limit, offset);
    }

    public long countLedger(OffsetDateTime from, OffsetDateTime to, UUID userId, UUID modelId,
                            String sourceType, UUID sourceId, String status) {
        return ledgerRepository.countLedger(from, to, userId, modelId, sourceType, sourceId, status);
    }

    /** 账本筛选下拉选项;userScope 非空时仅含该用户账本中出现过的基础数据(普通用户收敛)。 */
    public LlmLedgerJdbcRepository.LedgerFilterOptions ledgerFilterOptions(UUID userScope) {
        return ledgerRepository.filterOptions(userScope);
    }

    /** 按维度汇总某月消耗。dimension 取 user/pool_user/pool_org_unit/model。 */
    public List<LlmLedgerJdbcRepository.SummaryRow> summary(String dimension, String usageMonth) {
        return ledgerRepository.summary(dimension, usageMonth);
    }

    /** 池维度用户分解:某授权池当月按发起人聚合的消耗,总消耗倒序(复用 SummaryRow)。 */
    public List<LlmLedgerJdbcRepository.SummaryRow> poolUserBreakdown(String sourceType, UUID sourceId,
                                                                      UUID modelId, String usageMonth) {
        return ledgerRepository.poolUserBreakdown(sourceType, sourceId, modelId, usageMonth);
    }

    /**
     * 近一年消耗热力图:按天聚合,前端渲染 GitHub 风格年度格子。
     * userScope 非空时仅统计该用户(普通用户收敛),为空时全对象合计(系统管理员)。
     */
    public List<LlmLedgerJdbcRepository.DailyTotal> heatmapYear(UUID userScope) {
        LocalDate today = LocalDate.now();
        return ledgerRepository.heatmapYear(today.minusYears(1), today, userScope);
    }
}
