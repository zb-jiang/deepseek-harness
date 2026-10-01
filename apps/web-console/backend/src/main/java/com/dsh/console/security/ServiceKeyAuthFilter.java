package com.dsh.console.security;

import com.dsh.console.config.ServiceKeyProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * X-Service-Key 服务间认证过滤器:内网机器(flowable-engine、backend profile
 * 实例)无 Supabase 登录态,凭静态服务密钥访问白名单端点。
 *
 * <p>白名单(2026-10 知识库集成):仅 {@code GET /api/backend/kb/**}
 * (流程归属知识库解析 + 只读检索/清单/全文,见 BackendKbController)。
 * 携带头但密钥不符、未配置、方法非 GET 或路径不在白名单 → 401 fail loud,
 * 不静默降级为匿名 JWT 路径。无该头的请求原样放行走 JWT 过滤链。
 *
 * <p>认证通过后注入 {@link PreAuthenticatedAuthenticationToken}(principal 固定
 * {@code dsh-service}),满足 {@code /api/**} 的 authenticated 规则;白名单控制器
 * 不使用 {@code @AuthenticationPrincipal AuthContext}(服务身份无员工语义)。
 *
 * <p>不加 {@code @Component}:Spring Boot 会把 Filter bean 再注册进 servlet
 * 容器链造成双跑(OncePerRequestFilter 只防重入不防语义混乱),由 SecurityConfig
 * 构造并只挂 security 链。
 */
public class ServiceKeyAuthFilter extends OncePerRequestFilter {

    /** 服务密钥请求头。 */
    public static final String HEADER = "X-Service-Key";

    /** 白名单路径前缀:服务身份仅可访问后端知识库只读端点。 */
    private static final String KB_WHITELIST_PREFIX = "/api/backend/kb/";

    /** 注入 Authentication 的固定 principal。 */
    private static final String SERVICE_PRINCIPAL = "dsh-service";

    private final ServiceKeyProperties properties;

    public ServiceKeyAuthFilter(ServiceKeyProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String presented = request.getHeader(HEADER);
        if (presented == null) {
            chain.doFilter(request, response);
            return;
        }
        if (!isAllowed(request, presented)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "X-Service-Key 无效或路径不在白名单");
            return;
        }
        PreAuthenticatedAuthenticationToken authentication = new PreAuthenticatedAuthenticationToken(
            SERVICE_PRINCIPAL, presented, List.of(new SimpleGrantedAuthority("ROLE_DSH_SERVICE")));
        authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
        SecurityContextHolder.getContext().setAuthentication(authentication);
        try {
            chain.doFilter(request, response);
        } finally {
            SecurityContextHolder.clearContext();
        }
    }

    /**
     * 白名单判定:密钥恒时比对一致、GET 方法、路径以 {@link #KB_WHITELIST_PREFIX}
     * 开头;密钥未配置(空白)一律拒绝——机制关闭时携带头即显式失败。
     */
    private boolean isAllowed(HttpServletRequest request, String presented) {
        String configured = properties.serviceKey();
        if (configured == null || configured.isBlank()) {
            return false;
        }
        boolean keyMatches = MessageDigest.isEqual(
            configured.getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8));
        return keyMatches
            && "GET".equals(request.getMethod())
            && request.getRequestURI().startsWith(KB_WHITELIST_PREFIX);
    }
}
