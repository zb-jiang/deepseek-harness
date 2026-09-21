package com.dsh.console.backendprofile.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * backend profile 自注册/心跳请求体(POST /api/backend-profiles/register)。
 *
 * @param url            实例对外可达的调用 URL;按此 upsert
 * @param name           实例展示名
 * @param llmLabel       当前默认 LLM 标签(可空)
 * @param workspaceLabel 工作空间标签(可空)
 */
public record BackendProfileRegisterRequest(
    @NotBlank String url,
    @NotBlank String name,
    String llmLabel,
    String workspaceLabel
) {
}
