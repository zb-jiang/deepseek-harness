package com.dsh.console.llm.dto;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 用量账本明细视图。
 * 业务含义:对应 llm_usage_ledger 并联立展示名;append-only,审计与统计的真相源。
 */
public record UsageLedgerEntry(
    UUID id,
    String requestId,
    String usageMonth,
    UUID userId,
    String userDisplayName,
    UUID orgUnitId,
    String orgUnitName,
    String sourceType,
    UUID sourceId,
    String sourceName,
    UUID modelId,
    String modelDisplayName,
    String sessionId,
    String gatewayRequestId,
    String status,
    long reservedTokens,
    long promptTokens,
    long completionTokens,
    long totalTokens,
    long overageTokens,
    BigDecimal estimatedCost,
    String errorCode,
    String errorMessage,
    OffsetDateTime createdAt,
    OffsetDateTime completedAt
) {}
