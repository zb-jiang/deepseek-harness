package com.dsh.console.backendprofile.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * DSH backend profile 实例 DTO,对应 {@code public.backend_profiles} 表(setup guide §13.1)。
 *
 * @param id              主键 UUID
 * @param name            实例展示名
 * @param url             实例对外可达的调用 URL(flowable delegate 按此提交任务)
 * @param llmLabel        当前默认 LLM 标签(实例注册时上报,展示用)
 * @param workspaceLabel 工作空间标签(展示用)
 * @param lastHeartbeatAt 最近一次注册心跳时间
 * @param createdAt       创建时间
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BackendProfileDto(
    UUID id,
    String name,
    String url,
    String llmLabel,
    String workspaceLabel,
    OffsetDateTime lastHeartbeatAt,
    OffsetDateTime createdAt
) {
}
