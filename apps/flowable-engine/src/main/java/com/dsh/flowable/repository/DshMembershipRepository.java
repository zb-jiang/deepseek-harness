package com.dsh.flowable.repository;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 查询 {@code public.app_memberships} 表(参见 Supabase 手册 §5.3)。
 *
 * <p>用于 SoD 候选过滤(§6.7 B1):DshTaskListener 在 task create 时,如果 BPMN userTask
 * 只配了 {@code candidateGroups=role_id} 没显式列 candidateUsers,需要查 app_memberships
 * 拿该 role 下的直接 users,再应用 SoD 规则过滤。
 *
 * <p>注意:本 Repository 只查 <strong>直接 role</strong> 下的 users,不展开上级角色继承
 * (角色继承 §6.6 由 DSH task-api 层做,见 A1 方案)。引擎层只关心当前节点 candidateGroup
 * 对应的直接候选 users。
 */
@Repository
public class DshMembershipRepository {

    private final JdbcTemplate jdbcTemplate;

    public DshMembershipRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 查询指定 role 下的所有有效(active)用户的 user.id 列表。
     *
     * <p>SQL 用 PostgreSQL 数组包含操作符 {@code @>},查询 {@code role_ids} 数组
     * 包含 {@code roleId} 元素的所有 active membership。
     *
     * @param roleId 应用角色 id(对应 {@code app_roles.id});UUID 字符串
     * @return 直接绑定该角色的 active 用户 id 列表(Supabase Auth user.id);不含上级继承
     */
    public List<String> findActiveUserIdsByRoleId(String roleId) {
        if (roleId == null || roleId.isBlank()) {
            return List.of();
        }
        return jdbcTemplate.queryForList(
            "SELECT user_id::text FROM public.app_memberships "
                + "WHERE status = 'active' AND role_ids @> ARRAY[?::uuid]",
            String.class,
            roleId
        );
    }
}
