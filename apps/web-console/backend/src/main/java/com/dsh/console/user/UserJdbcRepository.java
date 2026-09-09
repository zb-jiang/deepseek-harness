package com.dsh.console.user;

import com.dsh.console.user.dto.UserDto;
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
 * {@code public.platform_users} 表数据访问。
 *
 * <p>读操作为主,写操作集中在 V1 的审批/禁用/锁定/平台角色更新。
 * 与 setup guide §4 表结构对齐。
 */
@Repository
public class UserJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, auth_subject, login_name, display_name, email, status,
               platform_roles, created_at, created_by,
               approved_at, approved_by,
               disabled_at, disabled_by, disabled_reason,
               locked_at, locked_by, locked_reason
        FROM public.platform_users
        """;

    private final JdbcClient jdbcClient;

    public UserJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 按 Supabase Auth user.id(auth_subject)查用户。用于 JWT 验证后查询治理状态。
     */
    public Optional<UserDto> findByAuthSubject(String authSubject) {
        return jdbcClient.sql(SELECT_BASE + " WHERE auth_subject = :authSubject")
            .param("authSubject", authSubject)
            .query(UserRowMapper.INSTANCE)
            .optional();
    }

    /**
     * 按主键查用户。
     */
    public Optional<UserDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(UserRowMapper.INSTANCE)
            .optional();
    }

    /**
     * 分页查所有用户(按创建时间倒序)。
     */
    public List<UserDto> list(int offset, int limit) {
        return jdbcClient.sql(SELECT_BASE + " ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("limit", limit)
            .param("offset", offset)
            .query(UserRowMapper.INSTANCE)
            .list();
    }

    /**
     * 按状态过滤分页查用户。
     */
    public List<UserDto> listByStatus(String status, int offset, int limit) {
        return jdbcClient.sql(SELECT_BASE + " WHERE status = :status ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("status", status)
            .param("limit", limit)
            .param("offset", offset)
            .query(UserRowMapper.INSTANCE)
            .list();
    }

    /**
     * 审批用户:status → active,记录审批人与审批时间。
     */
    public int approve(UUID userId, UUID approverId) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'active',
                approved_at = now(),
                approved_by = :approverId,
                platform_roles = CASE
                    WHEN COALESCE(array_length(platform_roles, 1), 0) = 0
                    THEN ARRAY['normal_user']::text[]
                    ELSE platform_roles
                END
            WHERE id = :userId AND status = 'pending_approval'
            """)
            .param("userId", userId)
            .param("approverId", approverId)
            .update();
    }

    /**
     * 禁用用户:status → disabled,记录禁用人与时间及原因。
     */
    public int disable(UUID userId, UUID disablerId, String reason) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'disabled', disabled_at = now(), disabled_by = :disablerId, disabled_reason = :reason
            WHERE id = :userId AND status != 'disabled'
            """)
            .param("userId", userId)
            .param("disablerId", disablerId)
            .param("reason", reason)
            .update();
    }

    /**
     * 锁定用户:status → locked,记录锁定人与时间及原因。
     */
    public int lock(UUID userId, UUID lockerId, String reason) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'locked', locked_at = now(), locked_by = :lockerId, locked_reason = :reason
            WHERE id = :userId AND status != 'locked'
            """)
            .param("userId", userId)
            .param("lockerId", lockerId)
            .param("reason", reason)
            .update();
    }

    /**
     * 激活用户(从 disabled/locked 恢复 active)。
     */
    public int activate(UUID userId) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'active'
            WHERE id = :userId AND status IN ('disabled', 'locked')
            """)
            .param("userId", userId)
            .update();
    }

    /**
     * 更新平台角色(覆盖写)。
     */
    public int updateRoles(UUID userId, List<String> roles) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET platform_roles = :roles
            WHERE id = :userId
            """)
            .param("userId", userId)
            .param("roles", roles == null ? List.of() : roles.toArray(new String[0]))
            .update();
    }

    /**
     * 统计给定 ID 集合中状态为 active 的用户数(应用唯一活跃管理员守卫)。
     */
    public int countActiveIn(List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        return jdbcClient.sql("""
            SELECT COUNT(*) FROM public.platform_users
            WHERE status = 'active' AND id = ANY(:ids)
            """)
            .param("ids", ids.toArray(new UUID[0]))
            .query(Integer.class)
            .single();
    }

    /**
     * RowMapper:snake_case 列 → camelCase 字段,处理 TEXT[] → List<String>。
     */
    static class UserRowMapper implements RowMapper<UserDto> {
        static final UserRowMapper INSTANCE = new UserRowMapper();

        @Override
        public UserDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new UserDto(
                rs.getObject("id", UUID.class),
                rs.getString("auth_subject"),
                rs.getString("login_name"),
                rs.getString("display_name"),
                rs.getString("email"),
                rs.getString("status"),
                toStringList(rs.getArray("platform_roles")),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("created_by", UUID.class),
                rs.getObject("approved_at", java.time.OffsetDateTime.class),
                rs.getObject("approved_by", UUID.class),
                rs.getObject("disabled_at", java.time.OffsetDateTime.class),
                rs.getObject("disabled_by", UUID.class),
                rs.getString("disabled_reason"),
                rs.getObject("locked_at", java.time.OffsetDateTime.class),
                rs.getObject("locked_by", UUID.class),
                rs.getString("locked_reason")
            );
        }

        private static List<String> toStringList(Array array) throws SQLException {
            if (array == null) {
                return List.of();
            }
            Object[] objArr = (Object[]) array.getArray();
            List<String> result = new ArrayList<>(objArr.length);
            for (Object o : objArr) {
                result.add(o == null ? null : o.toString());
            }
            return List.copyOf(result);
        }
    }
}
