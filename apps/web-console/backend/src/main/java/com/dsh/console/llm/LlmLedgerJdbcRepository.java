package com.dsh.console.llm;

import com.dsh.console.llm.dto.UsageLedgerEntry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 用量主账本的数据访问。
 * 业务含义:对应 llm_usage_ledger;append-only,状态经 reserved -> completed/failed/cancelled 迁移,
 * blocked 为终态;统计与热力图都从这张表聚合,不从 New API 抄数。
 */
@Repository
public class LlmLedgerJdbcRepository {

    /**
     * 按维度聚合的一行统计。
     * 业务含义:dimensionType 取 user/org_unit/model,分别按用户、扣费部门池、模型汇总。
     */
    public record SummaryRow(
        UUID subjectId,
        String subjectName,
        long totalTokens,
        long promptTokens,
        long completionTokens,
        long overageTokens,
        long requestCount
    ) {}

    /**
     * 按天聚合的一行消耗,全对象合计。
     * 业务含义:近一年消耗热力图的一天格子的数据源,不再按对象细分。
     */
    public record DailyTotal(
        LocalDate date,
        long totalTokens,
        long requestCount
    ) {}

    private final JdbcClient jdbcClient;

    public LlmLedgerJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    // ---------- 写入(预留/拦截) ----------

    /**
     * 写入预留账本。
     * 业务含义:额度路由命中后立即落一条 reserved 记录,requestId 贯穿后续结算与失败释放。
     */
    public void insertReserved(String requestId, String usageMonth, UUID userId,
                               UUID routeId, UUID routeItemId, Integer selectedPriority,
                               UUID orgUnitId, String sourceType, UUID sourceId,
                               UUID modelId, String sessionId, long reservedTokens) {
        jdbcClient.sql("""
                INSERT INTO public.llm_usage_ledger
                    (request_id, usage_month, user_id, route_id, route_item_id, selected_priority,
                     org_unit_id, source_type, source_id, model_id, session_id,
                     status, reserved_tokens)
                VALUES (:requestId, :month, :userId, :routeId, :routeItemId, :priority,
                        :orgUnitId, :sourceType, :sourceId, :modelId, :sessionId,
                        'reserved', :reservedTokens)
                """)
            .param("requestId", requestId)
            .param("month", usageMonth)
            .param("userId", userId)
            .param("routeId", routeId)
            .param("routeItemId", routeItemId)
            .param("priority", selectedPriority)
            .param("orgUnitId", orgUnitId)
            .param("sourceType", sourceType)
            .param("sourceId", sourceId)
            .param("modelId", modelId)
            .param("sessionId", sessionId)
            .param("reservedTokens", reservedTokens)
            .update();
    }

    /** 写入硬拦截账本(终态),不计任何 token。 */
    public void insertBlocked(String requestId, String usageMonth, UUID userId, UUID routeId,
                              UUID modelId, String sessionId) {
        jdbcClient.sql("""
                INSERT INTO public.llm_usage_ledger
                    (request_id, usage_month, user_id, route_id, source_type, source_id,
                     model_id, session_id, status, error_code, error_message, completed_at)
                VALUES (:requestId, :month, :userId, :routeId, 'user', :userId,
                        :modelId, :sessionId, 'blocked', 'LLM_QUOTA_EXHAUSTED',
                        '所有额度池本月额度均不足', now())
                """)
            .param("requestId", requestId)
            .param("month", usageMonth)
            .param("userId", userId)
            .param("routeId", routeId)
            .param("modelId", modelId)
            .param("sessionId", sessionId)
            .update();
    }

    // ---------- 状态迁移 ----------

    /** 按 requestId 锁行读取,供结算/释放做幂等判断。 */
    public Optional<LedgerRow> findByRequestIdForUpdate(String requestId) {
        return jdbcClient.sql("""
                SELECT id, request_id, usage_month, user_id, source_type, source_id, model_id,
                       status, reserved_tokens
                FROM public.llm_usage_ledger
                WHERE request_id = :requestId
                FOR UPDATE
                """)
            .param("requestId", requestId)
            .query((rs, rowNum) -> new LedgerRow(
                rs.getObject("id", UUID.class),
                rs.getString("request_id"),
                rs.getString("usage_month"),
                rs.getObject("user_id", UUID.class),
                rs.getString("source_type"),
                rs.getObject("source_id", UUID.class),
                rs.getObject("model_id", UUID.class),
                rs.getString("status"),
                rs.getLong("reserved_tokens")
            ))
            .optional();
    }

    /** 结算需要的锁行视图。 */
    public record LedgerRow(
        UUID id,
        String requestId,
        String usageMonth,
        UUID userId,
        String sourceType,
        UUID sourceId,
        UUID modelId,
        String status,
        long reservedTokens
    ) {}

    /**
     * 完成结算。
     * 算法:仅当状态仍为 reserved 时生效(幂等);overageTokens 为超出该池当月额度上限的部分。
     */
    public int complete(String requestId, long promptTokens, long completionTokens,
                        long overageTokens, java.math.BigDecimal estimatedCost,
                        String gatewayRequestId) {
        return jdbcClient.sql("""
                UPDATE public.llm_usage_ledger
                SET status = 'completed',
                    prompt_tokens = :prompt,
                    completion_tokens = :completion,
                    total_tokens = :prompt + :completion,
                    overage_tokens = :overage,
                    estimated_cost = :cost,
                    gateway_request_id = :gatewayRequestId,
                    completed_at = now()
                WHERE request_id = :requestId AND status = 'reserved'
                """)
            .param("prompt", promptTokens)
            .param("completion", completionTokens)
            .param("overage", overageTokens)
            .param("cost", estimatedCost)
            .param("gatewayRequestId", gatewayRequestId)
            .param("requestId", requestId)
            .update();
    }

    /** 失败/取消释放:仅当状态仍为 reserved 时生效(幂等)。 */
    public int fail(String requestId, String status, String errorCode, String errorMessage) {
        return jdbcClient.sql("""
                UPDATE public.llm_usage_ledger
                SET status = :status,
                    error_code = :errorCode,
                    error_message = :errorMessage,
                    completed_at = now()
                WHERE request_id = :requestId AND status = 'reserved'
                """)
            .param("status", status)
            .param("errorCode", errorCode)
            .param("errorMessage", errorMessage)
            .param("requestId", requestId)
            .update();
    }

    // ---------- 查询 ----------

    /**
     * 查询超过 staleBefore 仍停留在 reserved 的请求 id(孤儿预留)。
     * 业务含义:供定时清扫释放;按 created_at 升序限量返回,余量留给下一轮。
     */
    public List<String> findStaleReservedRequestIds(OffsetDateTime staleBefore, int limit) {
        return jdbcClient.sql("""
                SELECT request_id FROM public.llm_usage_ledger
                WHERE status = 'reserved' AND created_at < :staleBefore
                ORDER BY created_at
                LIMIT :limit
                """)
            .param("staleBefore", staleBefore)
            .param("limit", limit)
            .query(String.class)
            .list();
    }

    /**
     * 判断某模型是否已有任何账本记录(含 blocked 终态)。
     * 业务含义:账本 append-only 且统计查询内 JOIN 模型表,存在记录即不可物理删除模型。
     */
    public boolean existsByModelId(UUID modelId) {
        return jdbcClient.sql("""
                SELECT count(*) FROM public.llm_usage_ledger WHERE model_id = :modelId
                """)
            .param("modelId", modelId)
            .query(Long.class)
            .single() > 0;
    }

    /**
     * 账本明细分页查询。
     * 过滤条件全部可空;按 created_at 倒序。
     */
    public List<UsageLedgerEntry> listLedger(String usageMonth, UUID userId, UUID modelId,
                                             String status, int limit, int offset) {
        StringBuilder sql = new StringBuilder(LEDGER_SELECT + " WHERE 1=1");
        List<Object[]> conditions = new ArrayList<>();
        if (usageMonth != null) {
            sql.append(" AND l.usage_month = :month");
        }
        if (userId != null) {
            sql.append(" AND l.user_id = :userId");
        }
        if (modelId != null) {
            sql.append(" AND l.model_id = :modelId");
        }
        if (status != null) {
            sql.append(" AND l.status = :status");
        }
        sql.append(" ORDER BY l.created_at DESC LIMIT :limit OFFSET :offset");
        var spec = jdbcClient.sql(sql.toString());
        if (usageMonth != null) {
            spec = spec.param("month", usageMonth);
        }
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        if (modelId != null) {
            spec = spec.param("modelId", modelId);
        }
        if (status != null) {
            spec = spec.param("status", status);
        }
        return spec.param("limit", limit).param("offset", offset)
            .query(this::mapLedgerEntry)
            .list();
    }

    public long countLedger(String usageMonth, UUID userId, UUID modelId, String status) {
        StringBuilder sql = new StringBuilder(
            "SELECT count(*) FROM public.llm_usage_ledger l WHERE 1=1");
        if (usageMonth != null) {
            sql.append(" AND l.usage_month = :month");
        }
        if (userId != null) {
            sql.append(" AND l.user_id = :userId");
        }
        if (modelId != null) {
            sql.append(" AND l.model_id = :modelId");
        }
        if (status != null) {
            sql.append(" AND l.status = :status");
        }
        var spec = jdbcClient.sql(sql.toString());
        if (usageMonth != null) {
            spec = spec.param("month", usageMonth);
        }
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        if (modelId != null) {
            spec = spec.param("modelId", modelId);
        }
        if (status != null) {
            spec = spec.param("status", status);
        }
        return spec.query(Long.class).single();
    }

    /**
     * 按维度汇总某月消耗。
     * 算法:仅统计 completed;user 维度按发起人,org_unit 维度按实际扣费的部门池,model 维度按模型。
     */
    public List<SummaryRow> summary(String dimension, String usageMonth) {
        String subjectExpr = switch (dimension) {
            case "user" -> "l.user_id";
            case "org_unit" -> "l.source_id";
            case "model" -> "l.model_id";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String nameJoin = switch (dimension) {
            case "user" -> "LEFT JOIN public.platform_users s ON s.id = l.user_id";
            case "org_unit" -> "LEFT JOIN public.org_units s ON s.id = l.source_id";
            case "model" -> "LEFT JOIN public.llm_enterprise_models s ON s.id = l.model_id";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String nameExpr = switch (dimension) {
            case "user" -> "s.display_name";
            case "org_unit" -> "s.name";
            case "model" -> "s.display_name";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String whereExtra = "org_unit".equals(dimension) ? " AND l.source_type = 'org_unit'" : "";
        return jdbcClient.sql("""
                SELECT %s AS subject_id, max(%s) AS subject_name,
                       coalesce(sum(l.total_tokens), 0) AS total_tokens,
                       coalesce(sum(l.prompt_tokens), 0) AS prompt_tokens,
                       coalesce(sum(l.completion_tokens), 0) AS completion_tokens,
                       coalesce(sum(l.overage_tokens), 0) AS overage_tokens,
                       count(*) AS request_count
                FROM public.llm_usage_ledger l
                %s
                WHERE l.usage_month = :month AND l.status = 'completed'%s
                GROUP BY %s
                ORDER BY total_tokens DESC
                """.formatted(subjectExpr, nameExpr, nameJoin, whereExtra, subjectExpr))
            .param("month", usageMonth)
            .query((rs, rowNum) -> new SummaryRow(
                rs.getObject("subject_id", UUID.class),
                rs.getString("subject_name"),
                rs.getLong("total_tokens"),
                rs.getLong("prompt_tokens"),
                rs.getLong("completion_tokens"),
                rs.getLong("overage_tokens"),
                rs.getLong("request_count")
            ))
            .list();
    }

    /**
     * 近一年每日消耗热力图:闭区间日期内按天聚合,仅统计 completed。
     * userId 非空时仅统计该用户(普通用户收敛),为空时全对象合计(系统管理员)。
     * 算法:格子渲染与取色由前端完成,后端只回有消耗的日期。
     */
    public List<DailyTotal> heatmapYear(LocalDate start, LocalDate end, UUID userId) {
        StringBuilder sql = new StringBuilder("""
                SELECT l.created_at::date AS day,
                       coalesce(sum(l.total_tokens), 0) AS total_tokens,
                       count(*) AS request_count
                FROM public.llm_usage_ledger l
                WHERE l.status = 'completed' AND l.created_at::date BETWEEN :start AND :end
                """);
        if (userId != null) {
            sql.append(" AND l.user_id = :userId");
        }
        sql.append(" GROUP BY l.created_at::date ORDER BY day ASC");
        var spec = jdbcClient.sql(sql.toString())
            .param("start", start)
            .param("end", end);
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        return spec
            .query((rs, rowNum) -> new DailyTotal(
                rs.getObject("day", LocalDate.class),
                rs.getLong("total_tokens"),
                rs.getLong("request_count")
            ))
            .list();
    }

    // ---------- 内部 ----------

    private static final String LEDGER_SELECT = """
        SELECT l.id, l.request_id, l.usage_month, l.user_id, u.display_name AS user_display_name,
               l.org_unit_id, o.name AS org_unit_name,
               l.source_type, l.source_id,
               CASE l.source_type
                   WHEN 'user' THEN (SELECT display_name FROM public.platform_users su WHERE su.id = l.source_id)
                   ELSE (SELECT name FROM public.org_units so WHERE so.id = l.source_id)
               END AS source_name,
               l.model_id, m.display_name AS model_display_name,
               l.session_id, l.gateway_request_id, l.status,
               l.reserved_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
               l.overage_tokens, l.estimated_cost, l.error_code, l.error_message,
               l.created_at, l.completed_at
        FROM public.llm_usage_ledger l
        LEFT JOIN public.platform_users u ON u.id = l.user_id
        LEFT JOIN public.org_units o ON o.id = l.org_unit_id
        JOIN public.llm_enterprise_models m ON m.id = l.model_id
        """;

    private UsageLedgerEntry mapLedgerEntry(ResultSet rs, int rowNum) throws SQLException {
        return new UsageLedgerEntry(
            rs.getObject("id", UUID.class),
            rs.getString("request_id"),
            rs.getString("usage_month"),
            rs.getObject("user_id", UUID.class),
            rs.getString("user_display_name"),
            rs.getObject("org_unit_id", UUID.class),
            rs.getString("org_unit_name"),
            rs.getString("source_type"),
            rs.getObject("source_id", UUID.class),
            rs.getString("source_name"),
            rs.getObject("model_id", UUID.class),
            rs.getString("model_display_name"),
            rs.getString("session_id"),
            rs.getString("gateway_request_id"),
            rs.getString("status"),
            rs.getLong("reserved_tokens"),
            rs.getLong("prompt_tokens"),
            rs.getLong("completion_tokens"),
            rs.getLong("total_tokens"),
            rs.getLong("overage_tokens"),
            rs.getBigDecimal("estimated_cost"),
            rs.getString("error_code"),
            rs.getString("error_message"),
            rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("completed_at", OffsetDateTime.class)
        );
    }
}
