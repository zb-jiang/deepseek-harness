package com.dsh.console.llm.dto;

import java.util.List;
import java.util.UUID;

/**
 * 员工端可见模型视图。
 * 业务含义:员工模型目录项;pools 按路由优先级升序给出各额度池当月概况,供选择器 tooltip 展示。
 */
public record EmployeeModelDto(
    UUID id,
    String gatewayModelName,
    String displayName,
    Integer contextWindow,
    Integer maxTokens,
    Boolean reasoning,
    Boolean imageInput,
    String exhaustAction,
    List<PoolSummary> pools
) {

    /**
     * 单个额度池的当月概况。
     * 业务含义:monthlyLimitTokens/remainingTokens 为 -1 表示不限量;否则
     * remainingTokens = monthlyLimitTokens - consumedTokens - reservedTokens,可能为负(软提醒透支)。
     */
    public record PoolSummary(
        int priority,
        String sourceType,
        UUID sourceId,
        String sourceName,
        long monthlyLimitTokens,
        long consumedTokens,
        long reservedTokens,
        long remainingTokens
    ) {}
}
