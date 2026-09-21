package com.dsh.console.orgunit;

import com.dsh.console.orgunit.dto.OrgUnitDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.org_units} 组织树表数据访问。
 *
 * <p>组织树是全局治理数据(setup guide §11),规模为部门数量级(小数据),读路径一次拉
 * 全量由 Service 内存组树;同级同名唯一、循环引用、子部门删除守卫在 Service 内存校验,
 * 成员计数守卫在 {@link OrgUnitMemberJdbcRepository},本类只做 CRUD。
 */
@Repository
public class OrgUnitJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, name, parent_id, head_user_id, sort_order, created_at
        FROM public.org_units
        """;

    private final JdbcClient jdbcClient;

    public OrgUnitJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 拉全部部门(组树/校验/展示用;按同级排序与名称排序)。
     */
    public List<OrgUnitDto> list() {
        return jdbcClient.sql(SELECT_BASE + " ORDER BY sort_order, name")
            .query(OrgUnitRowMapper.INSTANCE)
            .list();
    }

    /**
     * 按主键查部门。
     */
    public Optional<OrgUnitDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(OrgUnitRowMapper.INSTANCE)
            .optional();
    }

    /**
     * 新建部门,返回生成的 id。
     *
     * @param name       部门名称(同级唯一由 Service 校验)
     * @param parentId   父部门 id;null=根
     * @param headUserId 负责人用户 id;null=不配置
     * @param sortOrder  同级排序
     */
    public UUID insert(String name, UUID parentId, UUID headUserId, int sortOrder) {
        return jdbcClient.sql("""
                INSERT INTO public.org_units (name, parent_id, head_user_id, sort_order)
                VALUES (:name, :parentId, :headUserId, :sortOrder)
                RETURNING id
                """)
            .param("name", name)
            .param("parentId", parentId)
            .param("headUserId", headUserId)
            .param("sortOrder", sortOrder)
            .query(UUID.class)
            .single();
    }

    /**
     * 更新部门(名称/父部门/负责人/排序全量覆盖)。
     */
    public int update(UUID id, String name, UUID parentId, UUID headUserId, int sortOrder) {
        return jdbcClient.sql("""
                UPDATE public.org_units
                SET name = :name, parent_id = :parentId, head_user_id = :headUserId, sort_order = :sortOrder
                WHERE id = :id
                """)
            .param("id", id)
            .param("name", name)
            .param("parentId", parentId)
            .param("headUserId", headUserId)
            .param("sortOrder", sortOrder)
            .update();
    }

    /**
     * 删除部门(守卫:无子部门、无成员,由 Service 校验后调用)。
     */
    public int delete(UUID id) {
        return jdbcClient.sql("DELETE FROM public.org_units WHERE id = :id")
            .param("id", id)
            .update();
    }

    /**
     * RowMapper:snake_case 列 → camelCase 字段。
     */
    static class OrgUnitRowMapper implements RowMapper<OrgUnitDto> {
        static final OrgUnitRowMapper INSTANCE = new OrgUnitRowMapper();

        @Override
        public OrgUnitDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new OrgUnitDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getObject("parent_id", UUID.class),
                rs.getObject("head_user_id", UUID.class),
                rs.getInt("sort_order"),
                rs.getObject("created_at", java.time.OffsetDateTime.class)
            );
        }
    }
}
