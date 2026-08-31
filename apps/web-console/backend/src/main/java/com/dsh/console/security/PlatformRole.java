package com.dsh.console.security;

/**
 * 平台角色常量,对应 {@code public.platform_users.platform_roles} 数组中的值。
 *
 * <p>setup guide §5.1 定义 platform_roles 字段为 TEXT[],V1 取值:
 * <ul>
 *   <li>{@link #SYSTEM_ADMIN}:平台系统管理员,全部 Web Console 功能</li>
 *   <li>{@link #APP_ADMIN}:应用管理员,仅限自己所属应用的配置操作</li>
 *   <li>{@link #NORMAL_USER}:普通平台用户,V1 主要走 DSH enterprise profile</li>
 * </ul>
 *
 * <p>Spring Security {@code hasRole()} 表达式自动加 {@code ROLE_} 前缀,
 * 与本常量值(全小写)经 {@code toUpperCase()} 后拼接,例如
 * {@code hasRole('SYSTEM_ADMIN')} 检查 authority {@code ROLE_SYSTEM_ADMIN}。
 */
public final class PlatformRole {

    /** 平台系统管理员:全部 Web Console 功能。 */
    public static final String SYSTEM_ADMIN = "system_admin";

    /** 应用管理员:仅限自己所属应用的配置操作。 */
    public static final String APP_ADMIN = "app_admin";

    /** 普通平台用户:V1 主要走 DSH enterprise profile。 */
    public static final String NORMAL_USER = "normal_user";

    private PlatformRole() {
    }
}
