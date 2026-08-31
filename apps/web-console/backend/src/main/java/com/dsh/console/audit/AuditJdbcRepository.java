package com.dsh.console.audit;

import com.dsh.console.audit.dto.AuditEventDto;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.audit_events} 表数据访问。
 *
 * <p>setup guide §4 表结构:id / event_type / target_user_id / operator_id / details(JSONB) / created_at。
 *
 * <p>写操作由 {@link AuditService} 在业务事务内调用;
 * 读操作由 {@link AuditController} 查审计日志页。
 */
@Repository
public class AuditJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, event_type, target_user_id, operator_id, details, created_at
        FROM public.audit_events
        """;

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public AuditJdbcRepository(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    /**
     * 插入审计事件。details 为任意可 JSON 序列化的对象。
     */
    public void insert(String eventType, UUID targetUserId, UUID operatorId, Map<String, Object> details) {
        String detailsJson = serializeDetails(details);
        jdbcClient.sql("""
            INSERT INTO public.audit_events (event_type, target_user_id, operator_id, details)
            VALUES (:eventType, :targetUserId, :operatorId, CAST(:details AS JSONB))
            """)
            .param("eventType", eventType)
            .param("targetUserId", targetUserId)
            .param("operatorId", operatorId)
            .param("details", detailsJson)
            .update();
    }

    /**
     * 分页查审计事件(按时间倒序,可按 event_type 与 operator_id 过滤)。
     */
    public List<AuditEventDto> list(String eventTypeFilter, UUID operatorIdFilter, int offset, int limit) {
        StringBuilder sql = new StringBuilder(SELECT_BASE).append(" WHERE 1=1");
        if (eventTypeFilter != null && !eventTypeFilter.isBlank()) {
            sql.append(" AND event_type = :eventType");
        }
        if (operatorIdFilter != null) {
            sql.append(" AND operator_id = :operatorId");
        }
        sql.append(" ORDER BY created_at DESC LIMIT :limit OFFSET :offset");

        var stmt = jdbcClient.sql(sql.toString())
            .param("limit", limit)
            .param("offset", offset);
        if (eventTypeFilter != null && !eventTypeFilter.isBlank()) {
            stmt = stmt.param("eventType", eventTypeFilter);
        }
        if (operatorIdFilter != null) {
            stmt = stmt.param("operatorId", operatorIdFilter);
        }
        return stmt.query(new AuditRowMapper(objectMapper)).list();
    }

    /**
     * 按目标用户查(用于用户治理页右侧"该用户的历史动作")。
     */
    public List<AuditEventDto> listByTargetUser(UUID targetUserId, int offset, int limit) {
        return jdbcClient.sql(SELECT_BASE + " WHERE target_user_id = :targetUserId ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("targetUserId", targetUserId)
            .param("limit", limit)
            .param("offset", offset)
            .query(new AuditRowMapper(objectMapper))
            .list();
    }

    private String serializeDetails(Map<String, Object> details) {
        if (details == null || details.isEmpty()) {
            return "{}";
        }
        try {
            return objectMapper.writeValueAsString(details);
        } catch (Exception e) {
            // 兜底:JSON 序列化失败不阻塞业务事务,记占位
            return "{\"serializationError\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    /**
     * RowMapper:处理 JSONB → Map<String, Object>(经 ObjectMapper)。
     */
    static class AuditRowMapper implements RowMapper<AuditEventDto> {
        private final ObjectMapper objectMapper;

        AuditRowMapper(ObjectMapper objectMapper) {
            this.objectMapper = objectMapper;
        }

        @Override
        public AuditEventDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            String detailsJson = rs.getString("details");
            Map<String, Object> details = parseDetails(detailsJson);
            return new AuditEventDto(
                rs.getObject("id", UUID.class),
                rs.getString("event_type"),
                rs.getObject("target_user_id", UUID.class),
                rs.getObject("operator_id", UUID.class),
                details,
                rs.getObject("created_at", java.time.OffsetDateTime.class)
            );
        }

        private Map<String, Object> parseDetails(String json) {
            if (json == null || json.isBlank()) {
                return Map.of();
            }
            try {
                return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
                });
            } catch (Exception e) {
                return Map.of("parseError", json);
            }
        }
    }
}
