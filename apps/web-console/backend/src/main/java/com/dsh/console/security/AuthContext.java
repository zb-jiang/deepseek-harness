package com.dsh.console.security;

import java.util.List;
import java.util.UUID;

/**
 * 当前登录用户的治理上下文,作为 Spring Security {@code Authentication#principal}。
 *
 * <p>由 {@link JwtAuthConverter} 在 JWT 验证后构造,
 * Controller 通过 {@code @AuthenticationPrincipal AuthContext} 注入。
 *
 * @param platformUserId  {@code public.platform_users.id},治理表主键
 * @param authSubject     Supabase Auth user.id,对应 JWT {@code sub} claim
 * @param email          平台用户邮箱
 * @param loginName      平台登录名
 * @param displayName    显示名称
 * @param roles          平台角色列表(对应 platform_roles 数组,可为空)
 */
public record AuthContext(
    UUID platformUserId,
    String authSubject,
    String email,
    String loginName,
    String displayName,
    List<String> roles
) {
    /**
     * 是否含某平台角色。
     */
    public boolean hasRole(String role) {
        return roles != null && roles.contains(role);
    }

    /**
     * 是否为平台系统管理员。
     */
    public boolean isSystemAdmin() {
        return hasRole(PlatformRole.SYSTEM_ADMIN);
    }
}
