package com.dsh.console.config;

import com.dsh.console.security.JwtAuthConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Spring Security 配置:Supabase JWT 本地验证。
 *
 * <p>认证模型为"认证直连 Supabase"(参见开发 SPEC §2.3):
 * <ul>
 *   <li>Web Console 前端直连 Supabase Auth 完成登录,拿 JWT。</li>
 *   <li>调用本服务 API 时带 {@code Authorization: Bearer <jwt>},
 *       本服务用 Supabase JWT Secret 在本地验证。</li>
 *   <li>JWT 验证通过后,通过 {@link JwtAuthConverter} 从 {@code sub} claim
 *       查 {@code public.platform_users} 取治理状态与平台角色,
 *       构造 {@link com.dsh.console.security.AuthContext}。</li>
 * </ul>
 *
 * <p>{@link EnableMethodSecurity} 启用 {@code @PreAuthorize} 方法级 RBAC,
 * 用于区分 {@code platform_admin} 与 {@code app_admin} 权限。
 *
 * <p>V1 仅校验 iss + exp;不校验 aud,允许 authenticated token 调用。
 */
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    private final SupabaseJwtProperties properties;
    private final JwtAuthConverter jwtAuthConverter;

    public SecurityConfig(SupabaseJwtProperties properties, JwtAuthConverter jwtAuthConverter) {
        this.properties = properties;
        this.jwtAuthConverter = jwtAuthConverter;
    }

    /**
     * 用 Supabase JWKS URI 构造 NimbusJwtDecoder,支持 ES256/RS256 等非对称算法。
     *
     * <p>Supabase 已迁移到新的 JWT Signing Keys(参见 dashboard Settings → JWT Keys),
     * 默认使用 ECDSA(ES256)签名,不再用 Legacy JWT Secret 的 HS256。
     * 通过 {@code /.well-known/jwks.json} 动态获取公钥验证。</p>
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        JwtDecoder decoder = JwtDecoders.fromIssuerLocation(properties.jwtIssuer());
        OAuth2TokenValidator<Jwt> withIssuer = JwtValidators.createDefaultWithIssuer(properties.jwtIssuer());
        if (decoder instanceof org.springframework.security.oauth2.jwt.NimbusJwtDecoder nimbus) {
            nimbus.setJwtValidator(withIssuer);
        }
        return decoder;
    }

    /**
     * 安全过滤链:无状态、CSRF 关闭、所有 API 端点要求认证。
     *
     * <p>{@code /api/**} 是 Web Console 自定义 REST 端点。
     * 静态资源({@code /**} 下的 index.html、assets)由 Spring Boot 默认 ResourceHandler 处理,
     * 不要求认证(前端登录页可访问)。
     */
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(authz -> authz
                .requestMatchers("/api/health").permitAll()
                .requestMatchers("/api/**").authenticated()
                .anyRequest().permitAll()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter)));
        return http.build();
    }
}
