package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * web-console 集成配置(2026-10 知识库集成):backend task 提交前解析流程归属
 * 应用的知识库。
 *
 * @param baseUrl    web-console 基地址(协议+主机+端口,无路径)
 * @param serviceKey 服务密钥,随 X-Service-Key 头调 {@code /api/backend/kb/**}
 *                   只读端点;须与 web-console {@code dsh.service-key} 一致,
 *                   空白时知识库解析直接降级为无 kb(告警日志)
 */
@ConfigurationProperties(prefix = "dsh.web-console")
public record DshWebConsoleProperties(
    String baseUrl,
    String serviceKey
) {
}
