package com.dsh.console.membership;

import com.dsh.console.membership.dto.AppMembershipDto;
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
 * {@code public.app_memberships} 表数据访问(setup guide §5.3)。
 *
 * <p>UNIQUE(app_id, user_id) 保证同一用户同一应用只有一条有效记录。
 */
@Repository
public class AppMembershipJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, app_id, user_id, role_ids, status, granted_at, granted_by
        FROM public.app_memberships
        """;

    private final JdbcClient jdbcClient;

    public AppMembershipJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public Optional<AppMembershipDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(MembershipRowMapper.INSTANCE)
            .optional();
    }

    public List<AppMembershipDto> listByApp(UUID appId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE app_id = :appId ORDER BY granted_at DESC")
            .param("appId", appId)
            .query(MembershipRowMapper.INSTANCE)
            .list();
    }

    public Optional<AppMembershipDto> findByAppAndUser(UUID appId, UUID userId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE app_id = :appId AND user_id = :userId")
            .param("appId", appId)
            .param("userId", userId)
            .query(MembershipRowMapper.INSTANCE)
            .optional();
    }

    /**
     * 用户全部 active 成员资格对应的应用 id 集合(员工端"可发起流程"聚合用)。
     */
    public List<UUID> listActiveAppIdsByUser(UUID userId) {
        return jdbcClient.sql(
            "SELECT app_id FROM public.app_memberships "
                + "WHERE user_id = :userId AND status = 'active'")
            .param("userId", userId)
            .query((rs, rowNum) -> rs.getObject("app_id", UUID.class))
            .list();
    }

    public UUID create(UUID appId, UUID userId, UUID[] roleIds, UUID grantedBy) {
        return jdbcClient.sql("""
            INSERT INTO public.app_memberships (app_id, user_id, role_ids, status, granted_by)
            VALUES (:appId, :userId, :roleIds, 'active', :grantedBy)
            RETURNING id
            """)
            .param("appId", appId)
            .param("userId", userId)
            .param("roleIds", roleIds)
            .param("grantedBy", grantedBy)
            .query(UUID.class)
            .single();
    }

    public int updateRoleIds(UUID id, UUID[] roleIds) {
        return jdbcClient.sql("UPDATE public.app_memberships SET role_ids = :roleIds WHERE id = :id")
            .param("id", id)
            .param("roleIds", roleIds)
            .update();
    }

    public int setStatus(UUID id, String status) {
        return jdbcClient.sql("UPDATE public.app_memberships SET status = :status WHERE id = :id")
            .param("id", id)
            .param("status", status)
            .update();
    }

    static class MembershipRowMapper implements RowMapper<AppMembershipDto> {
        static final MembershipRowMapper INSTANCE = new MembershipRowMapper();

        @Override
        public AppMembershipDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new AppMembershipDto(
                rs.getObject("id", UUID.class),
                rs.getObject("app_id", UUID.class),
                rs.getObject("user_id", UUID.class),
                toUuidList(rs.getArray("role_ids")),
                rs.getString("status"),
                rs.getObject("granted_at", java.time.OffsetDateTime.class),
                rs.getObject("granted_by", UUID.class)
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
