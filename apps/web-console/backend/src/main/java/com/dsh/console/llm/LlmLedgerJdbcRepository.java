package com.dsh.console.llm;

import com.dsh.console.llm.dto.UsageLedgerEntry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
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

    /**
     * 账本筛选下拉的一个可选项(id + 展示名)。
     * 业务含义:name 取账本名称快照优先、实时名兜底——被删除的实体仍可按历史名筛选。
     * type 仅 source 选项有意义(user/org_unit),其余为 null。
     */
    public record FilterOption(UUID id, String name, String type) {}

    /** 账本筛选下拉的全部选项;从账本 DISTINCT 而非配置表,天然覆盖已删除的用户/模型/来源。 */
    public record LedgerFilterOptions(
        List<FilterOption> users,
        List<FilterOption> models,
        List<FilterOption> sources
    ) {}

    private final JdbcClient jdbcClient;

    public LlmLedgerJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    // ---------- 写入(预留/拦截) ----------

    /**
     * 写入预留账本。
     * 业务含义:额度路由命中后立即落一条 reserved 记录,requestId 贯穿后续结算与失败释放。
     * 三个 *_name_snapshot 在写入时就地子查询快照:用户/模型/扣费来源之后被改名或删除,
     * 历史账本的展示与筛选不受影响(billing 记录不可变语义);实体在写入前已被删则快照为 NULL。
     */
    public void insertReserved(String requestId, String usageMonth, UUID userId,
                               UUID routeId, UUID routeItemId, Integer selectedPriority,
                               UUID orgUnitId, String sourceType, UUID sourceId,
                               UUID modelId, String sessionId, long reservedTokens) {
        jdbcClient.sql("""
                INSERT INTO public.llm_usage_ledger
                    (request_id, usage_month, user_id, route_id, route_item_id, selected_priority,
                     org_unit_id, source_type, source_id, model_id, session_id,
                     status, reserved_tokens,
                     user_name_snapshot, model_name_snapshot, source_name_snapshot)
                VALUES (:requestId, :month, :userId, :routeId, :routeItemId, :priority,
                        :orgUnitId, :sourceType, :sourceId, :modelId, :sessionId,
                        'reserved', :reservedTokens,
                        (SELECT display_name FROM public.platform_users WHERE id = :userId),
                        (SELECT display_name FROM public.llm_enterprise_models WHERE id = :modelId),
                        CASE :sourceType
                            WHEN 'user' THEN (SELECT display_name FROM public.platform_users WHERE id = :sourceId)
                            ELSE (SELECT name FROM public.org_units WHERE id = :sourceId)
                        END)
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

    /** 写入硬拦截账本(终态),不计任何 token;快照语义同 insertReserved。 */
    public void insertBlocked(String requestId, String usageMonth, UUID userId, UUID routeId,
                              UUID modelId, String sessionId) {
        jdbcClient.sql("""
                INSERT INTO public.llm_usage_ledger
                    (request_id, usage_month, user_id, route_id, source_type, source_id,
                     model_id, session_id, status, error_code, error_message, completed_at,
                     user_name_snapshot, model_name_snapshot, source_name_snapshot)
                VALUES (:requestId, :month, :userId, :routeId, 'user', :userId,
                        :modelId, :sessionId, 'blocked', 'LLM_QUOTA_EXHAUSTED',
                        '所有额度池本月额度均不足', now(),
                        (SELECT display_name FROM public.platform_users WHERE id = :userId),
                        (SELECT display_name FROM public.llm_enterprise_models WHERE id = :modelId),
                        (SELECT display_name FROM public.platform_users WHERE id = :userId))
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
     * 过滤条件全部可空;时间区间作用于 created_at,to 为排他上界;按 created_at 倒序。
     */
    public List<UsageLedgerEntry> listLedger(OffsetDateTime from, OffsetDateTime to, UUID userId,
                                             UUID modelId, String sourceType, UUID sourceId,
                                             String status, int limit, int offset) {
        StringBuilder sql = new StringBuilder(LEDGER_SELECT + " WHERE 1=1");
        if (from != null) {
            sql.append(" AND l.created_at >= :from");
        }
        if (to != null) {
            sql.append(" AND l.created_at < :to");
        }
        if (userId != null) {
            sql.append(" AND l.user_id = :userId");
        }
        if (modelId != null) {
            sql.append(" AND l.model_id = :modelId");
        }
        if (sourceType != null) {
            sql.append(" AND l.source_type = :sourceType");
        }
        if (sourceId != null) {
            sql.append(" AND l.source_id = :sourceId");
        }
        if (status != null) {
            sql.append(" AND l.status = :status");
        }
        sql.append(" ORDER BY l.created_at DESC LIMIT :limit OFFSET :offset");
        var spec = jdbcClient.sql(sql.toString());
        if (from != null) {
            spec = spec.param("from", from);
        }
        if (to != null) {
            spec = spec.param("to", to);
        }
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        if (modelId != null) {
            spec = spec.param("modelId", modelId);
        }
        if (sourceType != null) {
            spec = spec.param("sourceType", sourceType);
        }
        if (sourceId != null) {
            spec = spec.param("sourceId", sourceId);
        }
        if (status != null) {
            spec = spec.param("status", status);
        }
        return spec.param("limit", limit).param("offset", offset)
            .query(this::mapLedgerEntry)
            .list();
    }

    public long countLedger(OffsetDateTime from, OffsetDateTime to, UUID userId, UUID modelId,
                            String sourceType, UUID sourceId, String status) {
        StringBuilder sql = new StringBuilder(
            "SELECT count(*) FROM public.llm_usage_ledger l WHERE 1=1");
        if (from != null) {
            sql.append(" AND l.created_at >= :from");
        }
        if (to != null) {
            sql.append(" AND l.created_at < :to");
        }
        if (userId != null) {
            sql.append(" AND l.user_id = :userId");
        }
        if (modelId != null) {
            sql.append(" AND l.model_id = :modelId");
        }
        if (sourceType != null) {
            sql.append(" AND l.source_type = :sourceType");
        }
        if (sourceId != null) {
            sql.append(" AND l.source_id = :sourceId");
        }
        if (status != null) {
            sql.append(" AND l.status = :status");
        }
        var spec = jdbcClient.sql(sql.toString());
        if (from != null) {
            spec = spec.param("from", from);
        }
        if (to != null) {
            spec = spec.param("to", to);
        }
        if (userId != null) {
            spec = spec.param("userId", userId);
        }
        if (modelId != null) {
            spec = spec.param("modelId", modelId);
        }
        if (sourceType != null) {
            spec = spec.param("sourceType", sourceType);
        }
        if (sourceId != null) {
            spec = spec.param("sourceId", sourceId);
        }
        if (status != null) {
            spec = spec.param("status", status);
        }
        return spec.query(Long.class).single();
    }

    /**
     * 账本筛选下拉选项:用户/模型/扣费来源各自 DISTINCT。
     * 业务含义:选项源是账本而非配置表,已删除实体的历史记录仍可筛选;
     * 名称展示优先快照、实时名兜底。userScope 非空时仅统计该用户的账本(普通用户收敛,不泄露他人)。
     */
    public LedgerFilterOptions filterOptions(UUID userScope) {
        String scopeSql = userScope != null ? " WHERE l.user_id = :userId" : "";
        var userSpec = jdbcClient.sql("""
                SELECT DISTINCT l.user_id AS id,
                       coalesce(l.user_name_snapshot, u.display_name) AS name
                FROM public.llm_usage_ledger l
                LEFT JOIN public.platform_users u ON u.id = l.user_id%s
                ORDER BY name
                """.formatted(scopeSql));
        if (userScope != null) {
            userSpec = userSpec.param("userId", userScope);
        }
        List<FilterOption> users = userSpec
            .query((rs, rowNum) -> new FilterOption(
                rs.getObject("id", UUID.class), rs.getString("name"), null))
            .list();
        var modelSpec = jdbcClient.sql("""
                SELECT DISTINCT l.model_id AS id,
                       coalesce(l.model_name_snapshot, m.display_name) AS name
                FROM public.llm_usage_ledger l
                LEFT JOIN public.llm_enterprise_models m ON m.id = l.model_id%s
                ORDER BY name
                """.formatted(scopeSql));
        if (userScope != null) {
            modelSpec = modelSpec.param("userId", userScope);
        }
        List<FilterOption> models = modelSpec
            .query((rs, rowNum) -> new FilterOption(
                rs.getObject("id", UUID.class), rs.getString("name"), null))
            .list();
        var sourceSpec = jdbcClient.sql("""
                SELECT DISTINCT l.source_id AS id, l.source_type AS type,
                       coalesce(l.source_name_snapshot,
                           CASE l.source_type
                               WHEN 'user' THEN (SELECT display_name FROM public.platform_users su WHERE su.id = l.source_id)
                               ELSE (SELECT name FROM public.org_units so WHERE so.id = l.source_id)
                           END) AS name
                FROM public.llm_usage_ledger l%s
                ORDER BY name
                """.formatted(scopeSql));
        if (userScope != null) {
            sourceSpec = sourceSpec.param("userId", userScope);
        }
        List<FilterOption> sources = sourceSpec
            .query((rs, rowNum) -> new FilterOption(
                rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("type")))
            .list();
        return new LedgerFilterOptions(users, models, sources);
    }

    /**
     * 按维度汇总某月消耗。
     * 算法:仅统计 completed;user 维度按发起人(谁在用,真实用量);
     * pool_user/pool_org_unit 按实际扣费的个人池/部门池(池被消耗,含外部借用、不含员工走其他池的量);
     * model 维度按模型。员工与部门为多对多,不提供部门员工合计口径。
     */
    public List<SummaryRow> summary(String dimension, String usageMonth) {
        String subjectExpr = switch (dimension) {
            case "user" -> "l.user_id";
            case "pool_user", "pool_org_unit" -> "l.source_id";
            case "model" -> "l.model_id";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String nameJoin = switch (dimension) {
            case "user" -> "LEFT JOIN public.platform_users s ON s.id = l.user_id";
            case "pool_user" -> "LEFT JOIN public.platform_users s ON s.id = l.source_id";
            case "pool_org_unit" -> "LEFT JOIN public.org_units s ON s.id = l.source_id";
            case "model" -> "LEFT JOIN public.llm_enterprise_models s ON s.id = l.model_id";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String nameExpr = switch (dimension) {
            case "user", "pool_user", "model" -> "s.display_name";
            case "pool_org_unit" -> "s.name";
            default -> throw new IllegalArgumentException("未知统计维度: " + dimension);
        };
        String whereExtra = switch (dimension) {
            case "pool_user" -> " AND l.source_type = 'user'";
            case "pool_org_unit" -> " AND l.source_type = 'org_unit'";
            default -> "";
        };
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
     * 池维度用户分解:某授权池(sourceType+sourceId+modelId)在指定月份按发起人聚合的消耗,
     * 按总消耗倒序;仅统计 completed。复用 SummaryRow(subject_id=发起人, subject_name=用户显示名),
     * 供授权列表点击池子查看"谁在用这个池"。
     */
    public List<SummaryRow> poolUserBreakdown(String sourceType, UUID sourceId, UUID modelId,
                                              String usageMonth) {
        return jdbcClient.sql("""
                SELECT l.user_id AS subject_id, max(u.display_name) AS subject_name,
                       coalesce(sum(l.total_tokens), 0) AS total_tokens,
                       coalesce(sum(l.prompt_tokens), 0) AS prompt_tokens,
                       coalesce(sum(l.completion_tokens), 0) AS completion_tokens,
                       coalesce(sum(l.overage_tokens), 0) AS overage_tokens,
                       count(*) AS request_count
                FROM public.llm_usage_ledger l
                LEFT JOIN public.platform_users u ON u.id = l.user_id
                WHERE l.usage_month = :month AND l.status = 'completed'
                  AND l.source_type = :sourceType AND l.source_id = :sourceId
                  AND l.model_id = :modelId
                GROUP BY l.user_id
                ORDER BY total_tokens DESC
                """)
            .param("month", usageMonth)
            .param("sourceType", sourceType)
            .param("sourceId", sourceId)
            .param("modelId", modelId)
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

    /**
     * 明细行选择列:名称一律 coalesce(写入时快照, 实时名)——实体被删除后历史账本仍以快照名展示;
     * 模型必须 LEFT JOIN,内连接会让被删模型的账本行整体消失。
     */
    private static final String LEDGER_SELECT = """
        SELECT l.id, l.request_id, l.usage_month, l.user_id,
               coalesce(l.user_name_snapshot, u.display_name) AS user_display_name,
               l.org_unit_id, o.name AS org_unit_name,
               l.source_type, l.source_id,
               coalesce(l.source_name_snapshot,
                   CASE l.source_type
                       WHEN 'user' THEN (SELECT display_name FROM public.platform_users su WHERE su.id = l.source_id)
                       ELSE (SELECT name FROM public.org_units so WHERE so.id = l.source_id)
                   END) AS source_name,
               l.model_id,
               coalesce(l.model_name_snapshot, m.display_name) AS model_display_name,
               l.session_id, l.gateway_request_id, l.status,
               l.reserved_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
               l.overage_tokens, l.estimated_cost, l.error_code, l.error_message,
               l.created_at, l.completed_at
        FROM public.llm_usage_ledger l
        LEFT JOIN public.platform_users u ON u.id = l.user_id
        LEFT JOIN public.org_units o ON o.id = l.org_unit_id
        LEFT JOIN public.llm_enterprise_models m ON m.id = l.model_id
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
