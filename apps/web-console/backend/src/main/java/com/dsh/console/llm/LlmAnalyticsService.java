package com.dsh.console.llm;

import com.dsh.console.llm.dto.UsageLedgerEntry;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
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

    /** 账本明细分页。 */
    public List<UsageLedgerEntry> listLedger(String usageMonth, UUID userId, UUID modelId,
                                             String status, int limit, int offset) {
        return ledgerRepository.listLedger(usageMonth, userId, modelId, status, limit, offset);
    }

    public long countLedger(String usageMonth, UUID userId, UUID modelId, String status) {
        return ledgerRepository.countLedger(usageMonth, userId, modelId, status);
    }

    /** 按维度汇总某月消耗。dimension 取 user/org_unit/model。 */
    public List<LlmLedgerJdbcRepository.SummaryRow> summary(String dimension, String usageMonth) {
        return ledgerRepository.summary(dimension, usageMonth);
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
