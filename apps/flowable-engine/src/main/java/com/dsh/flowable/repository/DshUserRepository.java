package com.dsh.flowable.repository;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 查询 {@code public.platform_users} 表的展示名解析。
 *
 * <p>流程身份统一使用 Supabase Auth user.id({@code auth_subject},与员工端 JWT sub 同源),
 * 但前端展示需要员工显示名。本仓储按 auth_subject 批量反查 {@code display_name},
 * 供任务列表/详情把发起人渲染成人读名称;查不到的 id(如引擎内部身份、已删除用户)
 * 不出现在返回 Map 中,由调用方回退显示原 id。
 *
 * <p>与 {@link DshMembershipRepository} 同数据源(引擎 DataSource 指向 Supabase PostgreSQL);
 * H2 单测中不加载本仓储,由调用方注入 stub。
 */
@Repository
public class DshUserRepository {

    private final JdbcTemplate jdbcTemplate;

    public DshUserRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 按 auth_subject 批量查显示名。
     *
     * @param authSubjects 流程身份 id 集合(Supabase Auth user.id);空集合返回空 Map
     * @return auth_subject → display_name;只含查到的条目,不含未命中 id
     */
    public Map<String, String> findDisplayNamesByAuthSubjects(Collection<String> authSubjects) {
        if (authSubjects == null || authSubjects.isEmpty()) {
            return Map.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(authSubjects.size(), "?"));
        var rows = jdbcTemplate.queryForList(
            "SELECT auth_subject, display_name FROM public.platform_users "
                + "WHERE auth_subject IN (" + placeholders + ")",
            authSubjects.toArray());
        Map<String, String> names = new HashMap<>();
        for (var row : rows) {
            String subject = (String) row.get("auth_subject");
            String displayName = (String) row.get("display_name");
            if (subject != null && displayName != null) {
                names.put(subject, displayName);
            }
        }
        return names;
    }
}
