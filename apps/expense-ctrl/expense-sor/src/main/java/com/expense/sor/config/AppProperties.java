package com.expense.sor.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用配置项,均由环境变量注入(见设计文档第 11 节)。
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtIssuer,
        String serviceKey,
        String attachmentDir) {

    public boolean hasIssuer() {
        return jwtIssuer != null && !jwtIssuer.isBlank();
    }

    public boolean hasServiceKey() {
        return serviceKey != null && !serviceKey.isBlank();
    }
}
