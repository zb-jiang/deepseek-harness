package com.dsh.flowable.config;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Spring Security 配置:Supabase JWT 本地验证。
 *
 * <p>认证模型为"认证直连 Supabase"(参见 Supabase 手册 §0):
 * <ul>
 *   <li>员工端 DSH enterprise profile / Web Console 后端都直连 Supabase Auth 完成登录,拿 JWT。</li>
 *   <li>调用 Flowable 引擎 REST 时带 {@code Authorization: Bearer <jwt>},
 *       本服务用 Supabase JWT Secret 在本地验证。</li>
 *   <li>从 JWT 的 {@code sub} claim 提取 Supabase user.id,
 *       作为查询任务 {@code assignee} 的依据。</li>
 * </ul>
 *
 * <p>V1 仅校验 iss + exp(签发者与过期),不校验 aud(允许 authenticated / service_role 两种 token 调用,
 * 后者用于 Web Console 后端的 server-to-server 调用)。
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final SupabaseJwtProperties properties;

    public SecurityConfig(SupabaseJwtProperties properties) {
        this.properties = properties;
    }

    /**
     * 用 Supabase JWT Secret 构造 NimbusJwtDecoder,验证 HS256 签名。
     *
     * <p>secret encoding 由 {@link SupabaseJwtProperties#jwtSecretEncoding()} 决定:
     * <ul>
     *   <li>{@code utf8}(默认):raw 字符串直接转 UTF-8 bytes(self-hosted Supabase)。</li>
     *   <li>{@code base64}:Supabase cloud 项目 secret 是 base64 编码,需先 decode。</li>
     * </ul>
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        byte[] secretBytes = switch (properties.jwtSecretEncoding()) {
            case "base64" -> Base64.getDecoder().decode(properties.jwtSecret());
            default -> properties.jwtSecret().getBytes(StandardCharsets.UTF_8);
        };
        SecretKeySpec key = new SecretKeySpec(secretBytes, "HmacSHA256");
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
            .macAlgorithm(MacAlgorithm.HS256)
            .build();
        // 默认校验器校验 exp + iss,iss 设为 Supabase Project URL
        OAuth2TokenValidator<Jwt> withIssuer = JwtValidators.createDefaultWithIssuer(properties.jwtIssuer());
        decoder.setJwtValidator(withIssuer);
        return decoder;
    }

    /**
     * 安全过滤链:无状态、CSRF 关闭、所有 REST 端点要求认证。
     *
     * <p>{@code /process-api/**} 是 Flowable 官方 REST 端点(参见 Flowable 文档),
     * {@code /dsh/**} 是 DSH 自定义薄封装端点。
     */
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(authz -> authz
                .requestMatchers("/process-api/**", "/dsh/**").authenticated()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}));
        return http.build();
    }
}
