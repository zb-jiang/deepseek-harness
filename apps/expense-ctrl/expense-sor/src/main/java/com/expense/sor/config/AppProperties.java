package com.expense.sor.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用配置项,均由环境变量注入(见设计文档第 11 节)。
 * supabase 与 userDb 系列配置为 Web UI 新增(2026-09-24):
 * - supabaseUrl/supabaseAnonKey:前端登录直连 Supabase Auth 所需的客户端配置(anon key 本身为公开客户端密钥),
 *   由 /api/ui-config 下发给浏览器;
 * - userDb*:platform_users 表所在 PostgreSQL 库(默认 postgres 库 public schema),
 *   /api/me 用 JWT sub 匹配 auth_subject 列取 display_name 作为用户显示名。
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtIssuer,
        String serviceKey,
        String attachmentDir,
        String supabaseUrl,
        String supabaseAnonKey,
        String userDbHost,
        String userDbPort,
        String userDbName,
        String userDbUser,
        String userDbPassword) {

    public boolean hasIssuer() {
        return jwtIssuer != null && !jwtIssuer.isBlank();
    }

    public boolean hasServiceKey() {
        return serviceKey != null && !serviceKey.isBlank();
    }

    public boolean hasSupabase() {
        return supabaseUrl != null && !supabaseUrl.isBlank()
                && supabaseAnonKey != null && !supabaseAnonKey.isBlank();
    }
}
