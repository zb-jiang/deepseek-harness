package com.dsh.console.llm.dto;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 月度额度授权视图。
 * 业务含义:对应 llm_quota_grants;subjectName 为联立的用户显示名或部门名,仅供展示。
 */
public record QuotaGrantDto(
    UUID id,
    String subjectType,
    UUID subjectId,
    String subjectName,
    UUID modelId,
    String modelDisplayName,
    long monthlyLimitTokens,
    boolean enabled,
    LocalDate effectiveFrom,
    LocalDate effectiveTo,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {}
