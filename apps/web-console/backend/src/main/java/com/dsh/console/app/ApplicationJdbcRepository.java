package com.dsh.console.app;

import com.dsh.console.app.dto.ApplicationDto;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.applications} 表数据访问。
 *
 * <p>与 setup guide §5.1 表结构对齐,处理 UUID[] → List<UUID>。
 */
@Repository
public class ApplicationJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, name, description, icon, status, app_admin_user_ids,
               created_at, created_by, archived_at, archived_by
        FROM public.applications
        """;

    private final JdbcClient jdbcClient;

    public ApplicationJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public Optional<ApplicationDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(ApplicationRowMapper.INSTANCE)
            .optional();
    }

    public List<ApplicationDto> list(String statusFilter, int offset, int limit) {
        if (statusFilter == null || statusFilter.isBlank()) {
            return jdbcClient.sql(SELECT_BASE + " ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
                .param("limit", limit)
                .param("offset", offset)
                .query(ApplicationRowMapper.INSTANCE)
                .list();
        }
        return jdbcClient.sql(SELECT_BASE + " WHERE status = :status ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("status", statusFilter)
            .param("limit", limit)
            .param("offset", offset)
            .query(ApplicationRowMapper.INSTANCE)
            .list();
    }

    /**
     * 查询用户是管理员的全部应用(用于 app_admin 角色)。
     */
    public List<ApplicationDto> listByAdminUser(UUID userId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE :userId = ANY(app_admin_user_ids) AND status <> 'archived' ORDER BY created_at DESC")
            .param("userId", userId)
            .query(ApplicationRowMapper.INSTANCE)
            .list();
    }

    public UUID create(String name, String description, String icon,
                       UUID[] appAdminUserIds, UUID createdBy) {
        // gen_random_uuid() 由 DB 生成,RETURNING id 拿回
        return jdbcClient.sql("""
            INSERT INTO public.applications (name, description, icon, status,
                                             app_admin_user_ids, created_by)
            VALUES (:name, :description, :icon, 'draft',
                    :appAdminUserIds, :createdBy)
            RETURNING id
            """)
            .param("name", name)
            .param("description", description)
            .param("icon", icon)
            .param("appAdminUserIds", appAdminUserIds)
            .param("createdBy", createdBy)
            .query(UUID.class)
            .single();
    }

    public int update(UUID id, String name, String description, String icon,
                      UUID[] appAdminUserIds) {
        return jdbcClient.sql("""
            UPDATE public.applications
            SET name = :name, description = :description, icon = :icon,
                app_admin_user_ids = :appAdminUserIds
            WHERE id = :id AND status IN ('draft', 'active')
            """)
            .param("id", id)
            .param("name", name)
            .param("description", description)
            .param("icon", icon)
            .param("appAdminUserIds", appAdminUserIds)
            .update();
    }

    /**
     * 激活应用:draft → active。
     */
    public int activate(UUID id) {
        return jdbcClient.sql("UPDATE public.applications SET status = 'active' WHERE id = :id AND status = 'draft'")
            .param("id", id)
            .update();
    }

    /**
     * 归档应用:任意状态 → archived(终态)。
     */
    public int archive(UUID id, UUID archivedBy) {
        return jdbcClient.sql("""
            UPDATE public.applications
            SET status = 'archived', archived_at = now(), archived_by = :archivedBy
            WHERE id = :id AND status <> 'archived'
            """)
            .param("id", id)
            .param("archivedBy", archivedBy)
            .update();
    }

    static class ApplicationRowMapper implements RowMapper<ApplicationDto> {
        static final ApplicationRowMapper INSTANCE = new ApplicationRowMapper();

        @Override
        public ApplicationDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new ApplicationDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("description"),
                rs.getString("icon"),
                rs.getString("status"),
                toUuidList(rs.getArray("app_admin_user_ids")),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("created_by", UUID.class),
                rs.getObject("archived_at", java.time.OffsetDateTime.class),
                rs.getObject("archived_by", UUID.class)
            );
        }

        private static List<UUID> toUuidList(Array array) throws SQLException {
            if (array == null) {
                return List.of();
            }
            Object[] objArr = (Object[]) array.getArray();
            List<UUID> result = new ArrayList<>(objArr.length);
            for (Object o : objArr) {
                if (o != null) {
                    result.add(UUID.fromString(o.toString()));
                }
            }
            return List.copyOf(result);
        }
    }
}
