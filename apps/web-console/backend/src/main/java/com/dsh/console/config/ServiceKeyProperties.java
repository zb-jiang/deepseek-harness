package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务密钥(X-Service-Key)配置:内网机器服务间调用的静态凭证。
 *
 * <p>消费方:flowable-engine(backend task 知识库解析)与 backend profile
 * 实例(knowledge 插件 kb_* 工具)。各消费方的配置须与本值一致:
 * 引擎侧 {@code dsh.web-console.service-key}、backend profile 的
 * {@code DSH_SERVICE_KEY} 环境变量。
 *
 * @param serviceKey 密钥值;空白 = 机制关闭(所有携带 X-Service-Key 的请求 401)
 */
@ConfigurationProperties(prefix = "dsh")
public record ServiceKeyProperties(String serviceKey) {
}
