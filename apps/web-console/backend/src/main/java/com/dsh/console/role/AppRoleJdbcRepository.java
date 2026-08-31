package com.dsh.console.role;

import com.dsh.console.role.dto.AppRoleDto;
import java.util.List;
import java.util.Optional;
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
     * 检查循环引用:遍历 parent_role_id 链,看是否回到 startRoleId。
     *
     * <p>spec §7.6 角色继承规则 1:不允许循环。V1 在 create/update 时校验。
     */
    public boolean wouldCreateCycle(UUID roleId, UUID newParentRoleId) {
        if (newParentRoleId == null) {
            return false;
        }
        if (newParentRoleId.equals(roleId)) {
            return true;
        }
        // 遍历 parent 链,最多 32 层(防止意外长链)
        UUID current = newParentRoleId;
        for (int i = 0; i < 32 && current != null; i++) {
            if (current.equals(roleId)) {
                return true;
            }
            Optional<AppRoleDto> parent = findById(current);
            if (parent.isEmpty()) {
                return false;
            }
            current = parent.get().parentRoleId();
        }
        return false;
    }
}
