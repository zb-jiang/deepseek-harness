package com.expense.sor.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 服务间调用认证(设计文档 §4 第二认证方式):
 * 请求头 X-Service-Key 与配置一致即放行,但仅限下列五个端点
 * (读单/显式迁移/回写流程实例/写审批记录/写打款记录);
 * 其余端点(建单/附件/撤回/列表)仅接受用户 JWT,仅带服务密钥的请求一律 401。
 */
@Component
public class ServiceKeyAuthFilter extends OncePerRequestFilter {

    public static final String SERVICE_CALL_ATTR = "SOR_SERVICE_CALL";
    public static final String HEADER = "X-Service-Key";

    private static final AntPathMatcher MATCHER = new AntPathMatcher();

    /** 服务密钥可访问的端点白名单: {method, pattern} */
    private static final String[][] SERVICE_ALLOWED = {
            {HttpMethod.GET.name(),    "/api/expenses/{id}"},
            {HttpMethod.PUT.name(),    "/api/expenses/{id}/status"},
            {HttpMethod.PUT.name(),    "/api/expenses/{id}/process-instance"},
            {HttpMethod.POST.name(),   "/api/expenses/{id}/approval-records"},
            {HttpMethod.POST.name(),   "/api/expenses/{id}/payment"},
    };

    private final AppProperties props;

    public ServiceKeyAuthFilter(AppProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String key = request.getHeader(HEADER);
        String authorization = request.getHeader("Authorization");

        // 无服务密钥,或同时携带 JWT(以 JWT 为准),直接放行给后续 JWT 验签链
        if (key == null || key.isBlank()
                || (authorization != null && authorization.toLowerCase().startsWith("bearer "))) {
            chain.doFilter(request, response);
            return;
        }

        // 密钥不匹配 -> 401
        if (!props.hasServiceKey() || !props.serviceKey().equals(key)) {
            SecurityConfig.writeError(response, HttpServletResponse.SC_UNAUTHORIZED, 1401,
                    "UNAUTHORIZED", "X-Service-Key 无效");
            return;
        }

        // 密钥正确但端点不在服务调用白名单内 -> 401(仅 JWT 端点拦截)
        boolean allowed = false;
        for (String[] rule : SERVICE_ALLOWED) {
            if (rule[0].equalsIgnoreCase(request.getMethod())
                    && MATCHER.match(rule[1], request.getRequestURI())) {
                allowed = true;
                break;
            }
        }
        if (!allowed) {
            SecurityConfig.writeError(response, HttpServletResponse.SC_UNAUTHORIZED, 1401,
                    "UNAUTHORIZED", "该端点仅接受用户 JWT 认证");
            return;
        }

        var token = new PreAuthenticatedAuthenticationToken(
                "service-key", key, List.of(new SimpleGrantedAuthority("ROLE_SERVICE")));
        SecurityContextHolder.getContext().setAuthentication(token);
        request.setAttribute(SERVICE_CALL_ATTR, Boolean.TRUE);
        chain.doFilter(request, response);
    }
}
