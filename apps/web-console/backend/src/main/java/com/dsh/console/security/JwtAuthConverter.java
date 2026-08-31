package com.dsh.console.security;

import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.user.dto.UserDto;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

/**
 * JWT → Spring Security Authentication 转换器。
 *
 * <p>由 Spring Security 在 JWT 验证通过后调用,从 JWT 的 {@code sub} claim
 * 取 Supabase user.id,查 {@code public.platform_users} 取治理状态与平台角色,
 * 构造 {@link AuthContext} 作为 principal。
 *
 * <p>如治理记录不存在或 status 非 active,仍构造 AuthContext(roles=空),
 * 由 Controller 路由或方法级 RBAC 注解拒绝访问,不在此处抛异常(避免 token 验证与治理状态校验耦合)。
 */
@Component
public class JwtAuthConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    private static final Logger log = LoggerFactory.getLogger(JwtAuthConverter.class);

    private final UserJdbcRepository userJdbcRepository;

    public JwtAuthConverter(UserJdbcRepository userJdbcRepository) {
        this.userJdbcRepository = userJdbcRepository;
    }

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        String authSubject = jwt.getSubject();
        log.info("[JwtAuth] converting JWT sub={}", authSubject);
        Optional<UserDto> user = userJdbcRepository.findByAuthSubject(authSubject);

        if (user.isEmpty()) {
            log.warn("[JwtAuth] no platform_users record for sub={}", authSubject);
            return new AuthAuthenticationToken(new AuthContext(
                null, authSubject, null, null, null, List.of()));
        }
        if (!"active".equalsIgnoreCase(user.get().status())) {
            log.warn("[JwtAuth] user status={} for sub={}, not active",
                user.get().status(), authSubject);
            return new AuthAuthenticationToken(new AuthContext(
                null, authSubject, null, null, null, List.of()));
        }

        UserDto dto = user.get();
        List<String> roles = dto.platformRoles() == null ? List.of() : dto.platformRoles();
        return new AuthAuthenticationToken(new AuthContext(
            dto.id(),
            authSubject,
            dto.email(),
            dto.loginName(),
            dto.displayName(),
            roles));
    }

    /**
     * 自定义 AuthenticationToken,持有 AuthContext 与角色列表。
     *
     * <p>已认证状态(非 anonymous),authorities 取自 platform_roles,带 ROLE_ 前缀
     * 以兼容 {@code hasRole()} 表达式。
     */
    public static class AuthAuthenticationToken extends AbstractAuthenticationToken {

        private final AuthContext authContext;

        public AuthAuthenticationToken(AuthContext authContext) {
            super(authoritiesFor(authContext));
            this.authContext = authContext;
            setAuthenticated(true);
        }

        @Override
        public Object getPrincipal() {
            return authContext;
        }

        @Override
        public Object getCredentials() {
            return null;
        }

        private static List<GrantedAuthority> authoritiesFor(AuthContext ctx) {
            if (ctx == null || ctx.roles() == null) {
                return List.of();
            }
            List<GrantedAuthority> auths = new ArrayList<>(ctx.roles().size());
            for (String role : ctx.roles()) {
                if (role != null && !role.isBlank()) {
                    auths.add(new SimpleGrantedAuthority("ROLE_" + role.toUpperCase()));
                }
            }
            return List.copyOf(auths);
        }
    }
}
