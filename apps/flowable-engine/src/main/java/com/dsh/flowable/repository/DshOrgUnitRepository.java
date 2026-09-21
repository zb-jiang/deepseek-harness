package com.dsh.flowable.repository;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 查询 {@code public.org_units} / {@code public.org_unit_members}
 * (design 2026-09-19 组织维度审批路由;Supabase 手册 §11)。
 *
 * <p>组织树是公司级共享的行政线治理数据,规模为几十节点级,{@link #loadAll()} 一次
 * 全量拉取内存组树,避免逐级 parent 查询在远端 DB 上的多次往返。负责人以
 * auth_subject(流程身份,Supabase Auth user.id)返回,JOIN 转换与
 * {@link DshMembershipRepository} 的身份口径一致;部门成员归属在
 * {@code org_unit_members} 多对多映射(design 决策 10:员工可同时属多个部门)。
 *
 * <p>H2 单测中由调用方注入 stub 或建表填充,本类不感知引擎 DataSource。
 */
@Repository
public class DshOrgUnitRepository {

    /** 部门节点:id/name/parentId/headUserId(auth_subject 口径)。 */
    public record OrgUnit(String id, String name, String parentId, String headUserId) {}

    private final JdbcTemplate jdbcTemplate;

    public DshOrgUnitRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 全量加载组织树节点(含负责人,LEFT JOIN 保证未配负责人的部门也返回)。
     *
     * @return 节点列表;表不存在或为空返回空列表(组织维度未启用)
     */
    public List<OrgUnit> loadAll() {
        return jdbcTemplate.query(
            "SELECT o.id, o.name, o.parent_id, pu.auth_subject "
                + "FROM public.org_units o "
                + "LEFT JOIN public.platform_users pu ON pu.id = o.head_user_id",
            (rs, rowNum) -> new OrgUnit(
                rs.getString(1),
                rs.getString(2),
                rs.getString(3),
                rs.getString(4))
        );
    }

    /**
     * 查流程身份的全部部门 id(超时升级锚定当前审批人的回退路径,design 决策 13:
     * 调用方要求唯一——0 个或多个部门由调用方报错,不静默取某一个)。
     *
     * @param authSubject Supabase Auth user.id(JWT sub 同源)
     * @return org_unit_members 中该 active 用户的部门 id 列表;用户不存在/未激活/无部门返回空列表
     */
    public List<String> findOrgUnitIdsByAuthSubject(String authSubject) {
        if (authSubject == null || authSubject.isBlank()) {
            return List.of();
        }
        return jdbcTemplate.query(
            "SELECT om.org_unit_id FROM public.org_unit_members om "
                + "JOIN public.platform_users pu ON pu.id = om.user_id "
                + "WHERE pu.auth_subject = ? AND pu.status = 'active'",
            (rs, rowNum) -> rs.getString(1),
            authSubject
        );
    }

    /**
     * 批量查询指定部门集合内持有某实体角色的 active 成员,按部门分组。
     *
     * <p>服务两个场景:同行政线实体角色(逐级找第一个有该职位的部门)与指定部门
     * 子树过滤。成员归属按 {@code org_unit_members} 多对多判定(design 决策 10:
     * 员工跨部门任职时各隶属线都会命中——同一用户在其归属的每个部门各出一行,
     * 联合主键保证部门内不重复)。身份口径与 {@link DshMembershipRepository} 一致
     * (active membership + active platform_users,输出 auth_subject)。
     *
     * @param roleId      实体角色 id(app_roles.id)
     * @param orgUnitIds  部门 id 集合;空集合返回空 Map
     * @return org_unit_id → 该部门内该角色的 auth_subject 列表;无成员的部门不在 Map
     */
    public Map<String, List<String>> findRoleMembersByOrgUnitIds(String roleId, Collection<String> orgUnitIds) {
        if (roleId == null || roleId.isBlank()
            || orgUnitIds == null || orgUnitIds.isEmpty()) {
            return Map.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(orgUnitIds.size(), "?"));
        Map<String, List<String>> members = new HashMap<>();
        jdbcTemplate.query(
            "SELECT om.org_unit_id, pu.auth_subject FROM public.platform_users pu "
                + "JOIN public.org_unit_members om ON om.user_id = pu.id "
                + "JOIN public.app_memberships m ON m.user_id = pu.id "
                + "WHERE pu.status = 'active' AND m.status = 'active' "
                + "AND m.role_ids @> ARRAY[?::uuid] "
                + "AND om.org_unit_id IN (" + placeholders + ")",
            rs -> {
                while (rs.next()) {
                    members.computeIfAbsent(rs.getString(1), k -> new java.util.ArrayList<>())
                        .add(rs.getString(2));
                }
            },
            prepend(roleId, orgUnitIds));
        return members;
    }

    /** roleId 占位符在 IN 列表之前,组装参数数组。 */
    private static Object[] prepend(String roleId, Collection<String> orgUnitIds) {
        Object[] args = new Object[orgUnitIds.size() + 1];
        args[0] = roleId;
        int i = 1;
        for (String id : orgUnitIds) {
            args[i++] = id;
        }
        return args;
    }
}
