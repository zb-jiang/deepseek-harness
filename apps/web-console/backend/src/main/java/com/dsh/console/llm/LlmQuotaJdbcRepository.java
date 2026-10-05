package com.dsh.console.llm;

import com.dsh.console.llm.dto.QuotaGrantDto;
import com.dsh.console.llm.dto.UserModelRouteDto;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 额度授权、路由与月度余额的数据访问。
 * 业务含义:对应 llm_quota_grants / llm_user_model_routes(+items) / llm_monthly_balances 四张表。
 * 并发约束:余额行的预留与结算必须在事务内经 lockOrCreateBalance 的 SELECT ... FOR UPDATE 完成。
 */
@Repository
public class LlmQuotaJdbcRepository {

    /** 当前自然月键(yyyy-MM);与账本/余额行的 usage_month 口径一致。 */
    private static final DateTimeFormatter MONTH_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM");

    private static String currentMonth() {
        return YearMonth.now().format(MONTH_FORMAT);
    }

    /**
     * 月度余额行快照。
     * 业务含义:available = limitTokens - consumedTokens - reservedTokens;为负表示软提醒透支中;
     * limitTokens 为 -1 表示不限量(运行时跳过余额检查)。
     */
    public record BalanceRow(
        UUID id,
        String usageMonth,
        String sourceType,
        UUID sourceId,
        UUID modelId,
        long limitTokens,
        long reservedTokens,
        long consumedTokens,
        long overageTokens
    ) {}

    private final JdbcClient jdbcClient;

    public LlmQuotaJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    // ---------- 额度授权 ----------

    public List<QuotaGrantDto> listGrants(UUID modelId) {
        String sql = GRANT_SELECT + (modelId != null ? " WHERE g.model_id = :modelId" : "")
            + " ORDER BY g.created_at DESC";
        var spec = jdbcClient.sql(sql).param("month", currentMonth());
        if (modelId != null) {
            spec = spec.param("modelId", modelId);
        }
        return spec.query(this::mapGrant).list();
    }

    public Optional<QuotaGrantDto> findGrantById(UUID id) {
        return jdbcClient.sql(GRANT_SELECT + " WHERE g.id = :id")
            .param("id", id)
            .param("month", currentMonth())
            .query(this::mapGrant)
            .optional();
    }

    /**
     * 查某来源在某模型上当天的生效授权。
     * 算法:enabled 且 effective_from <= date 且 (effective_to 为空或 >= date),取最近创建的一条。
     */
    public Optional<QuotaGrantDto> findEffectiveGrant(String subjectType, UUID subjectId,
                                                      UUID modelId, LocalDate date) {
        return jdbcClient.sql(GRANT_SELECT + """
                WHERE g.subject_type = :subjectType AND g.subject_id = :subjectId
                  AND g.model_id = :modelId AND g.enabled
                  AND g.effective_from <= :date
                  AND (g.effective_to IS NULL OR g.effective_to >= :date)
                ORDER BY g.created_at DESC
                LIMIT 1
                """)
            .param("subjectType", subjectType)
            .param("subjectId", subjectId)
            .param("modelId", modelId)
            .param("date", date)
            .param("month", currentMonth())
            .query(this::mapGrant)
            .optional();
    }

    public UUID insertGrant(String subjectType, UUID subjectId, UUID modelId,
                            long monthlyLimitTokens, LocalDate effectiveFrom, LocalDate effectiveTo) {
        return jdbcClient.sql("""
                INSERT INTO public.llm_quota_grants
                    (subject_type, subject_id, model_id, monthly_limit_tokens, effective_from, effective_to)
                VALUES (:subjectType, :subjectId, :modelId, :limit, :from, :to)
                RETURNING id
                """)
            .param("subjectType", subjectType)
            .param("subjectId", subjectId)
            .param("modelId", modelId)
            .param("limit", monthlyLimitTokens)
            .param("from", effectiveFrom)
            .param("to", effectiveTo)
            .query(UUID.class)
            .single();
    }

    public int updateGrant(UUID id, long monthlyLimitTokens, LocalDate effectiveFrom, LocalDate effectiveTo) {
        return jdbcClient.sql("""
                UPDATE public.llm_quota_grants
                SET monthly_limit_tokens = :limit,
                    effective_from = :from,
                    effective_to = :to,
                    updated_at = now()
                WHERE id = :id
                """)
            .param("limit", monthlyLimitTokens)
            .param("from", effectiveFrom)
            .param("to", effectiveTo)
            .param("id", id)
            .update();
    }

    public int setGrantEnabled(UUID id, boolean enabled) {
        return jdbcClient.sql("""
                UPDATE public.llm_quota_grants SET enabled = :enabled, updated_at = now() WHERE id = :id
                """)
            .param("enabled", enabled)
            .param("id", id)
            .update();
    }

    // ---------- 用户模型路由 ----------

    public List<UserModelRouteDto> listRoutes(UUID userId) {
        String sql = ROUTE_SELECT + (userId != null ? " WHERE r.user_id = :userId" : "")
            + " ORDER BY r.created_at DESC";
        var spec = jdbcClient.sql(sql);
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        return spec.query(this::mapRoute).list().stream()
            .map(r -> r.withItems(listRouteItems(r.id())))
            .toList();
    }

    public Optional<UserModelRouteDto> findRouteByUserAndModel(UUID userId, UUID modelId) {
        return jdbcClient.sql(ROUTE_SELECT + " WHERE r.user_id = :userId AND r.model_id = :modelId AND r.enabled")
            .param("userId", userId)
            .param("modelId", modelId)
            .query(this::mapRoute)
            .optional()
            .map(r -> r.withItems(listRouteItems(r.id())));
    }

    public Optional<UserModelRouteDto> findRouteById(UUID id) {
        return jdbcClient.sql(ROUTE_SELECT + " WHERE r.id = :id")
            .param("id", id)
            .query(this::mapRoute)
            .optional()
            .map(r -> r.withItems(listRouteItems(r.id())));
    }

    public UUID insertRoute(UUID userId, UUID modelId, String exhaustAction) {
        return jdbcClient.sql("""
                INSERT INTO public.llm_user_model_routes (user_id, model_id, exhaust_action)
                VALUES (:userId, :modelId, :exhaustAction)
                ON CONFLICT (user_id, model_id)
                DO UPDATE SET exhaust_action = EXCLUDED.exhaust_action, enabled = TRUE, updated_at = now()
                RETURNING id
                """)
            .param("userId", userId)
            .param("modelId", modelId)
            .param("exhaustAction", exhaustAction)
            .query(UUID.class)
            .single();
    }

    public int updateRoute(UUID id, String exhaustAction, boolean enabled) {
        return jdbcClient.sql("""
                UPDATE public.llm_user_model_routes
                SET exhaust_action = :exhaustAction, enabled = :enabled, updated_at = now()
                WHERE id = :id
                """)
            .param("exhaustAction", exhaustAction)
            .param("enabled", enabled)
            .param("id", id)
            .update();
    }

    /**
     * 整体替换路由顺位项。
     * 算法:先删后插,由表级唯一约束保证 priority 与 source 不重复;调用方需在事务内执行。
     */
    public void replaceRouteItems(UUID routeId, List<RouteItemInput> items) {
        jdbcClient.sql("DELETE FROM public.llm_user_model_route_items WHERE route_id = :routeId")
            .param("routeId", routeId)
            .update();
        for (RouteItemInput item : items) {
            jdbcClient.sql("""
                    INSERT INTO public.llm_user_model_route_items (route_id, priority, source_type, source_id)
                    VALUES (:routeId, :priority, :sourceType, :sourceId)
                    """)
                .param("routeId", routeId)
                .param("priority", item.priority())
                .param("sourceType", item.sourceType())
                .param("sourceId", item.sourceId())
                .update();
        }
    }

    /** 路由顺位项的写入参数。 */
    public record RouteItemInput(int priority, String sourceType, UUID sourceId) {}

    // ---------- 月度余额 ----------

    /**
     * 锁定或创建余额行。
     * 算法:先 INSERT ON CONFLICT DO NOTHING 保证行存在,再 SELECT ... FOR UPDATE 拿行锁;
     * 必须在事务内调用,后续 addReserved/settle/releaseReserved 都作用于这个已锁定的行。
     */
    public BalanceRow lockOrCreateBalance(String month, String sourceType, UUID sourceId,
                                          UUID modelId, long limitTokens) {
        jdbcClient.sql("""
                INSERT INTO public.llm_monthly_balances
                    (usage_month, source_type, source_id, model_id, limit_tokens)
                VALUES (:month, :sourceType, :sourceId, :modelId, :limit)
                ON CONFLICT (usage_month, source_type, source_id, model_id) DO NOTHING
                """)
            .param("month", month)
            .param("sourceType", sourceType)
            .param("sourceId", sourceId)
            .param("modelId", modelId)
            .param("limit", limitTokens)
            .update();
        return jdbcClient.sql("""
                SELECT id, usage_month, source_type, source_id, model_id,
                       limit_tokens, reserved_tokens, consumed_tokens, overage_tokens
                FROM public.llm_monthly_balances
                WHERE usage_month = :month AND source_type = :sourceType
                  AND source_id = :sourceId AND model_id = :modelId
                FOR UPDATE
                """)
            .param("month", month)
            .param("sourceType", sourceType)
            .param("sourceId", sourceId)
            .param("modelId", modelId)
            .query(this::mapBalance)
            .single();
    }

    public int addReserved(UUID balanceId, long delta) {
        return jdbcClient.sql("""
                UPDATE public.llm_monthly_balances
                SET reserved_tokens = reserved_tokens + :delta, updated_at = now()
                WHERE id = :id
                """)
            .param("delta", delta)
            .param("id", balanceId)
            .update();
    }

    /**
     * 结算:释放预留并实扣。
     * 算法:reserved_tokens 减回预留量,consumed_tokens 加实扣量,overage_tokens 加超出额度上限的部分。
     */
    public int settle(UUID balanceId, long releaseReserved, long addConsumed, long addOverage) {
        return jdbcClient.sql("""
                UPDATE public.llm_monthly_balances
                SET reserved_tokens = reserved_tokens - :releaseReserved,
                    consumed_tokens = consumed_tokens + :addConsumed,
                    overage_tokens = overage_tokens + :addOverage,
                    updated_at = now()
                WHERE id = :id
                """)
            .param("releaseReserved", releaseReserved)
            .param("addConsumed", addConsumed)
            .param("addOverage", addOverage)
            .param("id", balanceId)
            .update();
    }

    /** 失败/取消时仅释放预留,不实扣。 */
    public int releaseReserved(UUID balanceId, long releaseReserved) {
        return jdbcClient.sql("""
                UPDATE public.llm_monthly_balances
                SET reserved_tokens = reserved_tokens - :releaseReserved, updated_at = now()
                WHERE id = :id
                """)
            .param("releaseReserved", releaseReserved)
            .param("id", balanceId)
            .update();
    }

    /**
     * 查某来源当月余额(不锁行),供员工目录与管理后台展示。
     */
    public Optional<BalanceRow> findBalance(String month, String sourceType, UUID sourceId, UUID modelId) {
        return jdbcClient.sql("""
                SELECT id, usage_month, source_type, source_id, model_id,
                       limit_tokens, reserved_tokens, consumed_tokens, overage_tokens
                FROM public.llm_monthly_balances
                WHERE usage_month = :month AND source_type = :sourceType
                  AND source_id = :sourceId AND model_id = :modelId
                """)
            .param("month", month)
            .param("sourceType", sourceType)
            .param("sourceId", sourceId)
            .param("modelId", modelId)
            .query(this::mapBalance)
            .optional();
    }

    // ---------- 删除模型级联清理 ----------

    /**
     * 删除模型前清理其配置面引用:授权、路由(含顺位项)与余额行。
     * 调用方需在事务内执行;用量账本不在此清理,有账本记录的模型由服务层拒绝删除。
     */
    public void deleteModelReferences(UUID modelId) {
        jdbcClient.sql("""
                DELETE FROM public.llm_user_model_route_items
                WHERE route_id IN (SELECT id FROM public.llm_user_model_routes WHERE model_id = :modelId)
                """)
            .param("modelId", modelId)
            .update();
        jdbcClient.sql("DELETE FROM public.llm_user_model_routes WHERE model_id = :modelId")
            .param("modelId", modelId)
            .update();
        jdbcClient.sql("DELETE FROM public.llm_quota_grants WHERE model_id = :modelId")
            .param("modelId", modelId)
            .update();
        jdbcClient.sql("DELETE FROM public.llm_monthly_balances WHERE model_id = :modelId")
            .param("modelId", modelId)
            .update();
    }

    // ---------- 内部 ----------

    /**
     * 授权查询基片段:联立当前自然月余额行,带出该授权在本周期的已消耗与剩余。
     * 剩余口径:授权或余额行快照为 -1(不限量)返回 -1;无余额行(本月未动)取授权当前值;
     * 有余额行按快照 limit - consumed - reserved(负数为软提醒透支,与运行时扣减口径一致,
     * 授权月中调整不改写已开行)。
     */
    private static final String GRANT_SELECT = """
        SELECT g.id, g.subject_type, g.subject_id,
               CASE g.subject_type
                   WHEN 'user' THEN (SELECT display_name FROM public.platform_users u WHERE u.id = g.subject_id)
                   ELSE (SELECT name FROM public.org_units o WHERE o.id = g.subject_id)
               END AS subject_name,
               g.model_id, m.display_name AS model_display_name,
               g.monthly_limit_tokens, g.enabled, g.effective_from, g.effective_to,
               g.created_at, g.updated_at,
               COALESCE(b.consumed_tokens, 0) AS period_consumed_tokens,
               CASE
                   WHEN g.monthly_limit_tokens < 0 THEN -1
                   WHEN b.id IS NULL THEN g.monthly_limit_tokens
                   WHEN b.limit_tokens < 0 THEN -1
                   ELSE b.limit_tokens - b.consumed_tokens - b.reserved_tokens
               END AS period_remaining_tokens
        FROM public.llm_quota_grants g
        JOIN public.llm_enterprise_models m ON m.id = g.model_id
        LEFT JOIN public.llm_monthly_balances b
            ON b.usage_month = :month AND b.source_type = g.subject_type
           AND b.source_id = g.subject_id AND b.model_id = g.model_id
        """;

    private static final String ROUTE_SELECT = """
        SELECT r.id, r.user_id, u.display_name AS user_display_name,
               r.model_id, m.display_name AS model_display_name,
               r.exhaust_action, r.enabled, r.created_at, r.updated_at
        FROM public.llm_user_model_routes r
        JOIN public.platform_users u ON u.id = r.user_id
        JOIN public.llm_enterprise_models m ON m.id = r.model_id
        """;

    private List<UserModelRouteDto.RouteItemDto> listRouteItems(UUID routeId) {
        return jdbcClient.sql("""
                SELECT i.id, i.priority, i.source_type, i.source_id,
                       CASE i.source_type
                           WHEN 'user' THEN (SELECT display_name FROM public.platform_users u WHERE u.id = i.source_id)
                           ELSE (SELECT name FROM public.org_units o WHERE o.id = i.source_id)
                       END AS source_name,
                       i.enabled
                FROM public.llm_user_model_route_items i
                WHERE i.route_id = :routeId
                ORDER BY i.priority ASC
                """)
            .param("routeId", routeId)
            .query((rs, rowNum) -> new UserModelRouteDto.RouteItemDto(
                rs.getObject("id", UUID.class),
                rs.getInt("priority"),
                rs.getString("source_type"),
                rs.getObject("source_id", UUID.class),
                rs.getString("source_name"),
                rs.getBoolean("enabled")
            ))
            .list();
    }

    private QuotaGrantDto mapGrant(ResultSet rs, int rowNum) throws SQLException {
        return new QuotaGrantDto(
            rs.getObject("id", UUID.class),
            rs.getString("subject_type"),
            rs.getObject("subject_id", UUID.class),
            rs.getString("subject_name"),
            rs.getObject("model_id", UUID.class),
            rs.getString("model_display_name"),
            rs.getLong("monthly_limit_tokens"),
            rs.getBoolean("enabled"),
            rs.getObject("effective_from", LocalDate.class),
            rs.getObject("effective_to", LocalDate.class),
            rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("updated_at", OffsetDateTime.class),
            rs.getLong("period_consumed_tokens"),
            rs.getLong("period_remaining_tokens")
        );
    }

    private UserModelRouteDto mapRoute(ResultSet rs, int rowNum) throws SQLException {
        return new UserModelRouteDto(
            rs.getObject("id", UUID.class),
            rs.getObject("user_id", UUID.class),
            rs.getString("user_display_name"),
            rs.getObject("model_id", UUID.class),
            rs.getString("model_display_name"),
            rs.getString("exhaust_action"),
            rs.getBoolean("enabled"),
            List.of(),
            rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("updated_at", OffsetDateTime.class)
        );
    }

    private BalanceRow mapBalance(ResultSet rs, int rowNum) throws SQLException {
        return new BalanceRow(
            rs.getObject("id", UUID.class),
            rs.getString("usage_month"),
            rs.getString("source_type"),
            rs.getObject("source_id", UUID.class),
            rs.getObject("model_id", UUID.class),
            rs.getLong("limit_tokens"),
            rs.getLong("reserved_tokens"),
            rs.getLong("consumed_tokens"),
            rs.getLong("overage_tokens")
        );
    }
}
