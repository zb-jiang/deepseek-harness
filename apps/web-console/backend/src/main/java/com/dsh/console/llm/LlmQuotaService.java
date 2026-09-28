package com.dsh.console.llm;

import com.dsh.console.audit.AuditService;
import com.dsh.console.llm.dto.QuotaGrantDto;
import com.dsh.console.llm.dto.UserModelRouteDto;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 额度授权与路由配置。
 * 业务含义:grant 决定"某来源在某模型上本月有多少 token";route 决定"某员工用某模型时按什么顺序扣哪些池"。
 * 校验职责:subject/source 的存在性在这里按 sourceType 分别校验平台用户表或部门表。
 */
@Service
public class LlmQuotaService {

    private static final Set<String> SUBJECT_TYPES = Set.of("user", "org_unit");
    private static final Set<String> EXHAUST_ACTIONS = Set.of("block", "allow_overage");

    private final LlmQuotaJdbcRepository quotaRepository;
    private final LlmCatalogJdbcRepository catalogRepository;
    private final JdbcClient jdbcClient;
    private final AuditService auditService;

    public LlmQuotaService(LlmQuotaJdbcRepository quotaRepository,
                           LlmCatalogJdbcRepository catalogRepository,
                           JdbcClient jdbcClient,
                           AuditService auditService) {
        this.quotaRepository = quotaRepository;
        this.catalogRepository = catalogRepository;
        this.jdbcClient = jdbcClient;
        this.auditService = auditService;
    }

    // ---------- 额度授权 ----------

    public List<QuotaGrantDto> listGrants(UUID modelId) {
        return quotaRepository.listGrants(modelId);
    }

    @Transactional
    public QuotaGrantDto createGrant(String subjectType, UUID subjectId, UUID modelId,
                                     long monthlyLimitTokens, LocalDate effectiveFrom,
                                     LocalDate effectiveTo, UUID operatorId) {
        validateSubject(subjectType, subjectId);
        validateModelExists(modelId);
        if (monthlyLimitTokens < 0) {
            throw new IllegalArgumentException("monthlyLimitTokens 不能为负");
        }
        if (effectiveFrom == null) {
            throw new IllegalArgumentException("effectiveFrom 不能为空");
        }
        if (effectiveTo != null && effectiveTo.isBefore(effectiveFrom)) {
            throw new IllegalArgumentException("effectiveTo 不能早于 effectiveFrom");
        }
        UUID id = quotaRepository.insertGrant(subjectType, subjectId, modelId,
            monthlyLimitTokens, effectiveFrom, effectiveTo);
        auditService.record("LLM_QUOTA_GRANT_CREATE", "llm_quota_grant", id, operatorId,
            Map.of("subjectType", subjectType, "subjectId", subjectId.toString(),
                "modelId", modelId.toString(), "monthlyLimitTokens", monthlyLimitTokens));
        return quotaRepository.findGrantById(id).orElseThrow();
    }

    @Transactional
    public QuotaGrantDto updateGrant(UUID id, long monthlyLimitTokens, LocalDate effectiveFrom,
                                     LocalDate effectiveTo, UUID operatorId) {
        quotaRepository.findGrantById(id)
            .orElseThrow(() -> new LlmException("LLM_GRANT_NOT_FOUND", "额度授权不存在", 404));
        if (effectiveTo != null && effectiveTo.isBefore(effectiveFrom)) {
            throw new IllegalArgumentException("effectiveTo 不能早于 effectiveFrom");
        }
        quotaRepository.updateGrant(id, monthlyLimitTokens, effectiveFrom, effectiveTo);
        auditService.record("LLM_QUOTA_GRANT_UPDATE", "llm_quota_grant", id, operatorId, null);
        return quotaRepository.findGrantById(id).orElseThrow();
    }

    @Transactional
    public QuotaGrantDto setGrantEnabled(UUID id, boolean enabled, UUID operatorId) {
        quotaRepository.findGrantById(id)
            .orElseThrow(() -> new LlmException("LLM_GRANT_NOT_FOUND", "额度授权不存在", 404));
        quotaRepository.setGrantEnabled(id, enabled);
        auditService.record(enabled ? "LLM_QUOTA_GRANT_ENABLE" : "LLM_QUOTA_GRANT_DISABLE",
            "llm_quota_grant", id, operatorId, null);
        return quotaRepository.findGrantById(id).orElseThrow();
    }

    // ---------- 用户模型路由 ----------

    public List<UserModelRouteDto> listRoutes(UUID userId) {
        return quotaRepository.listRoutes(userId);
    }

    public UserModelRouteDto getRoute(UUID id) {
        return quotaRepository.findRouteById(id)
            .orElseThrow(() -> new LlmException("LLM_ROUTE_NOT_FOUND", "路由不存在", 404));
    }

    /**
     * 创建或整体更新路由(含顺位项)。
     * 算法:路由头按 (user_id, model_id) upsert;顺位项整体替换,由表级唯一约束兜底重复。
     */
    @Transactional
    public UserModelRouteDto upsertRoute(UUID userId, UUID modelId, String exhaustAction,
                                         List<LlmQuotaJdbcRepository.RouteItemInput> items,
                                         UUID operatorId) {
        validateModelExists(modelId);
        if (!EXHAUST_ACTIONS.contains(exhaustAction)) {
            throw new IllegalArgumentException("exhaustAction 必须是 block 或 allow_overage");
        }
        if (items == null || items.isEmpty()) {
            throw new IllegalArgumentException("路由顺位项不能为空");
        }
        for (LlmQuotaJdbcRepository.RouteItemInput item : items) {
            validateSubject(item.sourceType(), item.sourceId());
        }
        UUID routeId = quotaRepository.insertRoute(userId, modelId, exhaustAction);
        quotaRepository.replaceRouteItems(routeId, items);
        auditService.record("LLM_ROUTE_UPSERT", "llm_user_model_route", routeId, operatorId,
            Map.of("userId", userId.toString(), "modelId", modelId.toString(),
                "exhaustAction", exhaustAction, "itemCount", items.size()));
        return quotaRepository.findRouteById(routeId).orElseThrow();
    }

    @Transactional
    public UserModelRouteDto updateRoute(UUID id, String exhaustAction, boolean enabled,
                                         List<LlmQuotaJdbcRepository.RouteItemInput> items,
                                         UUID operatorId) {
        quotaRepository.findRouteById(id)
            .orElseThrow(() -> new LlmException("LLM_ROUTE_NOT_FOUND", "路由不存在", 404));
        if (!EXHAUST_ACTIONS.contains(exhaustAction)) {
            throw new IllegalArgumentException("exhaustAction 必须是 block 或 allow_overage");
        }
        quotaRepository.updateRoute(id, exhaustAction, enabled);
        if (items != null && !items.isEmpty()) {
            for (LlmQuotaJdbcRepository.RouteItemInput item : items) {
                validateSubject(item.sourceType(), item.sourceId());
            }
            quotaRepository.replaceRouteItems(id, items);
        }
        auditService.record("LLM_ROUTE_UPDATE", "llm_user_model_route", id, operatorId, null);
        return quotaRepository.findRouteById(id).orElseThrow();
    }

    // ---------- 内部 ----------

    private void validateModelExists(UUID modelId) {
        catalogRepository.findModelById(modelId)
            .orElseThrow(() -> new LlmException("LLM_MODEL_NOT_FOUND", "模型不存在", 404));
    }

    /**
     * 按 subjectType 校验目标存在。
     * 业务解释:user 指向 platform_users,org_unit 指向 org_units;配置错误的来源必须失败 loud。
     */
    private void validateSubject(String subjectType, UUID subjectId) {
        if (!SUBJECT_TYPES.contains(subjectType)) {
            throw new IllegalArgumentException("subjectType 必须是 user 或 org_unit");
        }
        String table = "user".equals(subjectType) ? "public.platform_users" : "public.org_units";
        boolean exists = jdbcClient.sql("SELECT count(*) FROM " + table + " WHERE id = :id")
            .param("id", subjectId)
            .query(Long.class)
            .single() > 0;
        if (!exists) {
            throw new LlmException("LLM_SUBJECT_NOT_FOUND",
                ("user".equals(subjectType) ? "用户" : "部门") + "不存在: " + subjectId, 404);
        }
    }
}
