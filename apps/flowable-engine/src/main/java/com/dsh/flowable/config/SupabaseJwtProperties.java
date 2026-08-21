package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Supabase JWT 验证配置。
 *
 * <p>绑定 yaml 中 {@code dsh.supabase.*} 字段。Supabase Auth 签发的 JWT 用 HS256 算法,
 * secret 通过本属性注入 NimbusJwtDecoder,在本地验证签名(参见 Supabase 手册 §10.2)。
 *
 * @param jwtSecret          Supabase JWT Secret(服务端专用,不暴露到前端)
 * @param jwtIssuer          JWT iss claim(Supabase 默认是 Project URL)
 * @param jwtSecretEncoding  secret 编码:utf8(默认,raw 字符串字节) | base64(Supabase cloud secret 是 base64)
 */
@ConfigurationProperties(prefix = "dsh.supabase")
public record SupabaseJwtProperties(
    String jwtSecret,
    String jwtIssuer,
    String jwtSecretEncoding
) {
    /**
     * 默认 encoding 为 utf8,兼容 raw 字符串 secret(self-hosted Supabase 常见格式)。
     */
    public String jwtSecretEncoding() {
        return jwtSecretEncoding == null || jwtSecretEncoding.isBlank() ? "utf8" : jwtSecretEncoding;
    }
}
