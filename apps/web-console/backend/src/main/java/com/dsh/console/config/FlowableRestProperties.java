package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Flowable 引擎 REST 客户端配置。
 *
 * <p>绑定 yaml 中 {@code dsh.flowable.*} 字段。Web Console 后端通过 RestClient 调
 * Flowable 引擎 REST 部署 BPMN / 发起实例 / 查任务 / 管理员干预。
 *
 * <p>认证采用"认证直连 Supabase":Web Console 调用 Flowable 时透传当前用户的 Supabase JWT,
 * Flowable 引擎用同一 JWT Secret 验证;无需 server-to-server basic auth 或共享密钥。
 *
 * @param baseUrl Flowable 引擎 base URL(默认 http://127.0.0.1:8090,参见 setup guide §10.2)
 */
@ConfigurationProperties(prefix = "dsh.flowable")
public record FlowableRestProperties(String baseUrl) {
}
