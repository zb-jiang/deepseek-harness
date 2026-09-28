package com.dsh.console.llm;

import com.dsh.console.llm.dto.EnterpriseModelDto;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 企业模型目录的数据访问。
 * 业务含义:对应 llm_enterprise_models 一张表;上游凭据不落本库,单一事实源在 New API 渠道。
 */
@Repository
public class LlmCatalogJdbcRepository {

    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private static final String MODEL_SELECT = """
        SELECT m.id, m.display_name,
               m.gateway_model_name, m.model_params_json,
               m.reservation_tokens, m.enabled,
               m.created_at, m.updated_at
        FROM public.llm_enterprise_models m
        """;

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public LlmCatalogJdbcRepository(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ---------- 企业模型 ----------

    public List<EnterpriseModelDto> listModels() {
        return jdbcClient.sql(MODEL_SELECT + " ORDER BY m.created_at DESC")
            .query(this::mapModel)
            .list();
    }

    public Optional<EnterpriseModelDto> findModelById(UUID id) {
        return jdbcClient.sql(MODEL_SELECT + " WHERE m.id = :id")
            .param("id", id)
            .query(this::mapModel)
            .optional();
    }

    public Optional<EnterpriseModelDto> findEnabledModelByGatewayName(String gatewayModelName) {
        return jdbcClient.sql(MODEL_SELECT + " WHERE m.gateway_model_name = :name AND m.enabled")
            .param("name", gatewayModelName)
            .query(this::mapModel)
            .optional();
    }

    public UUID insertModel(String displayName,
                            String gatewayModelName,
                            Map<String, Object> modelParams, int reservationTokens) {
        return jdbcClient.sql("""
                INSERT INTO public.llm_enterprise_models
                    (display_name, gateway_model_name,
                     model_params_json, reservation_tokens)
                VALUES (:displayName, :gatewayModelName,
                        CAST(:modelParams AS jsonb), :reservationTokens)
                RETURNING id
                """)
            .param("displayName", displayName)
            .param("gatewayModelName", gatewayModelName)
            .param("modelParams", toJson(modelParams))
            .param("reservationTokens", reservationTokens)
            .query(UUID.class)
            .single();
    }

    public int updateModel(UUID id, String displayName, String gatewayModelName,
                           Map<String, Object> modelParams,
                           int reservationTokens) {
        return jdbcClient.sql("""
                UPDATE public.llm_enterprise_models
                SET display_name = :displayName,
                    gateway_model_name = :gatewayModelName,
                    model_params_json = CAST(:modelParams AS jsonb),
                    reservation_tokens = :reservationTokens,
                    updated_at = now()
                WHERE id = :id
                """)
            .param("displayName", displayName)
            .param("gatewayModelName", gatewayModelName)
            .param("modelParams", toJson(modelParams))
            .param("reservationTokens", reservationTokens)
            .param("id", id)
            .update();
    }

    public int setModelEnabled(UUID id, boolean enabled) {
        return jdbcClient.sql("""
                UPDATE public.llm_enterprise_models
                SET enabled = :enabled, updated_at = now()
                WHERE id = :id
                """)
            .param("enabled", enabled)
            .param("id", id)
            .update();
    }

    public int deleteModel(UUID id) {
        return jdbcClient.sql("DELETE FROM public.llm_enterprise_models WHERE id = :id")
            .param("id", id)
            .update();
    }

    // ---------- 映射 ----------

    private EnterpriseModelDto mapModel(ResultSet rs, int rowNum) throws SQLException {
        return new EnterpriseModelDto(
            rs.getObject("id", UUID.class),
            rs.getString("display_name"),
            rs.getString("gateway_model_name"),
            toMap(rs.getObject("model_params_json")),
            rs.getInt("reservation_tokens"),
            rs.getBoolean("enabled"),
            rs.getObject("created_at", java.time.OffsetDateTime.class),
            rs.getObject("updated_at", java.time.OffsetDateTime.class)
        );
    }

    private Map<String, Object> toMap(Object jsonb) {
        // PG 驱动的 jsonb 列返回 PGobject,其 toString() 即 JSON 文本;驱动为 runtime scope,不直接引用其类型
        try {
            if (jsonb == null) {
                return Map.of();
            }
            String json = jsonb.toString();
            if (json.isBlank()) {
                return Map.of();
            }
            return objectMapper.readValue(json, MAP_TYPE);
        } catch (Exception e) {
            return Map.of();
        }
    }

    private String toJson(Map<String, Object> map) {
        try {
            return objectMapper.writeValueAsString(map == null ? Map.of() : map);
        } catch (Exception e) {
            throw new IllegalArgumentException("JSON 序列化失败: " + e.getMessage());
        }
    }
}
