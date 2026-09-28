package com.dsh.console.llm.dto;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;

/**
 * 企业逻辑模型视图。
 * 业务含义:对应 llm_enterprise_models;员工端展示用 displayName,推理转发用 gatewayModelName;
 * 上游凭据与渠道路由不在本视图,单一事实源在 New API 渠道。
 */
public record EnterpriseModelDto(
    UUID id,
    String displayName,
    String gatewayModelName,
    Map<String, Object> modelParams,
    int reservationTokens,
    boolean enabled,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {}
