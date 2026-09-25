package com.dsh.flowable.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

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
        if (decoder instanceof NimbusJwtDecoder nimbus) {
            nimbus.setJwtValidator(withIssuer);
        }
        return decoder;
    }

    /**
     * 安全过滤链:无状态、CSRF 关闭、健康检查放行、其余端点要求认证。
     *
     * <p>路径规则用 {@link AntPathRequestMatcher} 而非字符串形式:本应用有两个 servlet
     * (Spring MVC 的 {@code /} + Flowable REST 的 {@code /process-api/*}),
     * 字符串 requestMatchers 会被构造成 MvcRequestMatcher,多 servlet 场景下
     * Spring Security 无法推断 servlet path,请求时直接抛 IllegalArgumentException。
     * AntPathRequestMatcher 与 servlet 数量无关。
     *
     * <p>{@code /actuator/health} 免认证供部署探活(load balancer / k8s probe);
     * {@code /actuator/metrics/**} 免认证供 web-console 定时轮询采集引擎指标——
     * 轮询方(后台调度线程)没有用户 JWT 可透传,先例是 web-console 的
     * backend-profiles register permitAll("内网服务间信任,第一期");exposure 只开
     * health,metrics 两个端点(application.yml),不含 env/configprops/beans,
     * 指标数值不含敏感信息。V2 收紧为静态 service token。
     * <p>{@code /process-api/**} 是 Flowable 官方 REST 端点(参见 Flowable 文档),
     * {@code /dsh/**} 是 DSH 自定义薄封装端点。
     */
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(authz -> authz
                .requestMatchers(AntPathRequestMatcher.antMatcher("/actuator/health")).permitAll()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/actuator/metrics/**")).permitAll()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/process-api/**")).authenticated()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/dsh/**")).authenticated()
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}));
        return http.build();
    }
}
