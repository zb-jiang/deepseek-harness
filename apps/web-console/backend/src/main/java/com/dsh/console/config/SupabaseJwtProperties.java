package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Supabase JWT 验证配置。
 *
 * <p>绑定 yaml 中 {@code dsh.supabase.*} 字段。
 * 使用 {@link JwtDecoders#fromIssuerLocation} 从 Supabase OpenID 发现端点
 * 自动拉取 JWKS 验证 ES256/RS256 签名,不再本地配置 secret。</p>
 *
 * @param jwtIssuer JWT iss claim(Supabase Auth 为 https://<ref>.supabase.co/auth/v1)
 */
@ConfigurationProperties(prefix = "dsh.supabase")
public record SupabaseJwtProperties(
    String jwtIssuer
) {}
