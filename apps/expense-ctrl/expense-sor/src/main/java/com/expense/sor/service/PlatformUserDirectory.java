package com.expense.sor.service;

import com.expense.sor.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * 平台用户目录查询(Web UI 新增,2026-09-24):
 * /api/me 用 JWT sub(UUID)匹配 platform_users 表 auth_subject 列,取 display_name 作为用户显示名。
 *
 * 表位于独立于 SOR 主库(expense)的库(默认 postgres 库 public schema,可用 SOR_USER_DB_* 覆盖),
 * 因此单独建数据源,与主数据源互不影响。
 *
 * 实现要点:使用 DriverManagerDataSource(惰性连接,构造不触发真实连接),
 * 平台库不可达不能拖垮 SOR 启动 —— 首次查询失败后本进程内短路降级,前端回退 JWT email。
 */
@Service
public class PlatformUserDirectory {

    private static final Logger log = LoggerFactory.getLogger(PlatformUserDirectory.class);

    private final JdbcTemplate jdbc;
    private volatile boolean unavailable = false;

    public PlatformUserDirectory(AppProperties props) {
        DriverManagerDataSource ds = new DriverManagerDataSource(
                "jdbc:postgresql://" + props.userDbHost() + ":" + props.userDbPort()
                        + "/" + props.userDbName(),
                props.userDbUser(), props.userDbPassword());
        ds.setDriverClassName("org.postgresql.Driver");
        // 注:DriverManagerDataSource 未实现 setLoginTimeout(抛 UnsupportedOperationException),不可调用;
        // 查询超时已通过 JdbcTemplate.setQueryTimeout 限制
        this.jdbc = new JdbcTemplate(ds);
        this.jdbc.setQueryTimeout(3);
    }

    /** 按 auth_subject(JWT sub)查 display_name;库/表不可用时返回 empty */
    public Optional<String> findDisplayName(String authSubject) {
        if (authSubject == null || authSubject.isBlank() || unavailable) {
            return Optional.empty();
        }
        try {
            return jdbc.query(
                    "SELECT display_name FROM platform_users WHERE auth_subject = ?",
                    (rs, i) -> rs.getString(1), authSubject).stream().findFirst();
        } catch (DataAccessException e) {
            // 平台库连不上/表或列不存在:降级,避免每次请求都打满超时 —— 首次失败后本进程内短路
            unavailable = true;
            log.warn("platform_users 查询失败,用户显示名将回退到 JWT email: {}", e.getMessage());
            return Optional.empty();
        }
    }
}
