package com.dsh.console.backendprofile;

import com.dsh.console.backendprofile.dto.BackendProfileDto;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.backend_profiles} 表数据访问(setup guide §13.1)。
 *
 * <p>DSH backend profile 实例注册表:实例周期自注册(心跳),设计器画 DSH
 * backend task 节点时从 {@link #listActive()} 拉活跃实例做下拉。
 */
@Repository
public class BackendProfileJdbcRepository {

    /** active 判定阈值:心跳 5 分钟内(注册周期 60s 的冗余)。 */
    private static final String ACTIVE_WINDOW = "INTERVAL '5 minutes'";

    private static final String SELECT_BASE = """
        SELECT id, name, url, llm_label, workspace_label, last_heartbeat_at, created_at
        FROM public.backend_profiles
        """;

    private final JdbcClient jdbcClient;

    public BackendProfileJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 自注册/心跳:按 url upsert(新实例插入,已注册实例刷新元数据与心跳)。
     */
    public void upsert(String url, String name, String llmLabel, String workspaceLabel) {
        jdbcClient.sql("""
            INSERT INTO public.backend_profiles (url, name, llm_label, workspace_label, last_heartbeat_at)
            VALUES (:url, :name, :llmLabel, :workspaceLabel, now())
            ON CONFLICT (url) DO UPDATE SET
                name = EXCLUDED.name,
                llm_label = EXCLUDED.llm_label,
                workspace_label = EXCLUDED.workspace_label,
                last_heartbeat_at = now()
            """)
            .param("url", url)
            .param("name", name)
            .param("llmLabel", llmLabel)
            .param("workspaceLabel", workspaceLabel)
            .update();
    }

    /**
     * 心跳新鲜的活跃实例(设计器下拉数据源)。
     */
    public List<BackendProfileDto> listActive() {
        return jdbcClient.sql(
                SELECT_BASE + " WHERE last_heartbeat_at > now() - " + ACTIVE_WINDOW + " ORDER BY created_at")
            .query(this::mapRow)
            .list();
    }

    private BackendProfileDto mapRow(java.sql.ResultSet rs, long rowNum) throws java.sql.SQLException {
        return new BackendProfileDto(
            rs.getObject("id", java.util.UUID.class),
            rs.getString("name"),
            rs.getString("url"),
            rs.getString("llm_label"),
            rs.getString("workspace_label"),
            rs.getObject("last_heartbeat_at", java.time.OffsetDateTime.class),
            rs.getObject("created_at", java.time.OffsetDateTime.class)
        );
    }
}
