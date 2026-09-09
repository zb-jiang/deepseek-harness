package com.dsh.console.role;

import com.dsh.console.role.dto.AppRoleDto;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.app_roles} 表数据访问(setup guide §5.2)。
 *
 * <p>UNIQUE(app_id, name) 保证应用内角色名唯一;parent_role_id 应用层校验同 app_id。
 */
@Repository
public class AppRoleJdbcRepository {

    /** 角色层级写锁的咨询锁命名空间(与应用内其它咨询锁区分)。 */
    private static final int ADVISORY_NS_ROLE_HIERARCHY = 706;

    private static final String SELECT_BASE = """
        SELECT id, app_id, name, description, status, parent_role_id, created_at, created_by
        FROM public.app_roles
        """;

    private final JdbcClient jdbcClient;

    public AppRoleJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public Optional<AppRoleDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query((rs, n) -> new AppRoleDto(
                rs.getObject("id", UUID.class),
                rs.getObject("app_id", UUID.class),
                rs.getString("name"),
                rs.getString("description"),
                rs.getString("status"),
                rs.getObject("parent_role_id", UUID.class),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("created_by", UUID.class)))
            .optional();
    }

    public List<AppRoleDto> listByApp(UUID appId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE app_id = :appId ORDER BY created_at")
            .param("appId", appId)
            .query((rs, n) -> new AppRoleDto(
                rs.getObject("id", UUID.class),
                rs.getObject("app_id", UUID.class),
                rs.getString("name"),
                rs.getString("description"),
                rs.getString("status"),
                rs.getObject("parent_role_id", UUID.class),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("created_by", UUID.class)))
            .list();
    }

    public UUID create(UUID appId, String name, String description, UUID parentRoleId, UUID createdBy) {
        return jdbcClient.sql("""
            INSERT INTO public.app_roles (app_id, name, description, status, parent_role_id, created_by)
            VALUES (:appId, :name, :description, 'active', :parentRoleId, :createdBy)
            RETURNING id
            """)
            .param("appId", appId)
            .param("name", name)
            .param("description", description)
            .param("parentRoleId", parentRoleId)
            .param("createdBy", createdBy)
            .query(UUID.class)
            .single();
    }

    public int update(UUID id, String name, String description, UUID parentRoleId) {
        return jdbcClient.sql("""
            UPDATE public.app_roles
            SET name = :name, description = :description, parent_role_id = :parentRoleId
            WHERE id = :id
            """)
            .param("id", id)
            .param("name", name)
            .param("description", description)
            .param("parentRoleId", parentRoleId)
            .update();
    }

    public int setStatus(UUID id, String status) {
        return jdbcClient.sql("UPDATE public.app_roles SET status = :status WHERE id = :id")
            .param("id", id)
            .param("status", status)
            .update();
    }

    /**
     * 检查把 roleId 的父角色改为 newParentRoleId 是否会形成循环。
     *
     * <p>spec §7.6 角色继承规则 1:不允许循环。V1 在 create/update 时校验。
     * 从 newParentRoleId 沿 parent_role_id 链上溯,任一祖先是 roleId 即成环。
     * 用 visited 集合判重:遍历步数以角色总数为上界;存量数据意外成环时也能终止
     * (环不含 roleId 则本次修改不引入新环,按无环处理)。
     */
    public boolean wouldCreateCycle(UUID roleId, UUID newParentRoleId) {
        if (newParentRoleId == null) {
            return false;
        }
        Set<UUID> visited = new HashSet<>();
        UUID current = newParentRoleId;
        while (current != null) {
            if (current.equals(roleId)) {
                return true;
            }
            if (!visited.add(current)) {
                return false;
            }
            Optional<AppRoleDto> parent = findById(current);
            if (parent.isEmpty()) {
                return false;
            }
            current = parent.get().parentRoleId();
        }
        return false;
    }

    /**
     * 取应用级角色层级写锁(事务结束自动释放)。
     *
     * <p>create/update 的"查环 + 写 parent_role_id"不是原子操作:两个并发事务
     * 互设对方为父角色时,各自查环都看不到对方未提交的写入,提交后成环。
     * 同一应用的角色层级变更经此锁串行化后,后到事务查环时能看到先到事务
     * 已提交的父链。
     */
    public void lockHierarchy(UUID appId) {
        jdbcClient.sql("SELECT pg_advisory_xact_lock(hashtext(:appId), :ns)")
            .param("appId", appId.toString())
            .param("ns", ADVISORY_NS_ROLE_HIERARCHY)
            .query((rs, rowNum) -> rs.getObject(1))
            .list();
    }
}
