package com.dsh.console.llm;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * New API 网关连接配置。
 * 业务含义:serviceToken 用于推理转发(/v1/chat/completions),必须对应 New API 中额度不限、
 * 永不过期的令牌;渠道配置在 New API 控制台手工维护,不经本服务。
 */
@ConfigurationProperties(prefix = "newapi")
public record NewApiProperties(
    String baseUrl,
    String serviceToken
) {}
