package com.dsh.flowable.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 查询 {@code public.applications} / {@code public.workflow_definitions}
 * (参见 Supabase 手册 §5)。
 *
 * <p>skill 预装扫描(/dsh/skills/required)需要把流程定义映射到所属应用绑定的
 * SkillHub namespace:流程定义级 app 归属只存在 web-console 的
 * {@code workflow_definitions}(deployment 不带 tenantId/appId),引擎与治理表
 * 共用同一 Supabase PG,跨 schema JOIN 即得,不引入新连接。
 *
 * <p>局限:{@code published_procdef_id} 只记录最近一次发布;流程重新发布后,
 * 仍运行在旧 procdef 上的实例 JOIN 不上,skill 清单里该来源的 namespace 为 null,
 * 由调用方跳过(不做 deployment name 字符串反解,避免耦合展示格式)。
 */
@Repository
public class DshApplicationRepository {

    private final JdbcTemplate jdbcTemplate;

    public DshApplicationRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 查询流程定义所属应用绑定的 SkillHub namespace。
     *
     * @param procdefId Flowable 流程定义 id(PROC_DEF 表主键)
     * @return 应用的 skillhub_namespace;流程定义未归属任何应用、应用未绑定
     *         namespace 或流程定义来自旧一次发布(记录已被覆盖)时返回 null
     */
    public String findSkillhubNamespaceByProcdefId(String procdefId) {
        if (procdefId == null || procdefId.isBlank()) {
            return null;
        }
        return jdbcTemplate.query(
            "SELECT a.skillhub_namespace FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.published_procdef_id = ? LIMIT 1",
            (rs, rowNum) -> rs.getString(1),
            procdefId
        ).stream().findFirst().orElse(null);
    }

    /**
     * 查询流程定义所属应用 id(TaskDto.applicationId 的数据源)。
     *
     * <p>员工端凭 applicationId 定位该应用的知识库(design 2026-09-11 §6);
     * JOIN 口径与 {@link #findSkillhubNamespaceByProcdefId} 一致,局限也相同
     * (旧发布实例 JOIN 不上返回 null,由调用方降级隐藏知识库入口)。
     *
     * @param procdefId Flowable 流程定义 id(PROC_DEF 表主键)
     * @return 应用 id(UUID 字符串);流程定义未归属任何应用时返回 null
     */
    public String findApplicationIdByProcdefId(String procdefId) {
        if (procdefId == null || procdefId.isBlank()) {
            return null;
        }
        return jdbcTemplate.query(
            "SELECT a.id FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.published_procdef_id = ? LIMIT 1",
            (rs, rowNum) -> rs.getString(1),
            procdefId
        ).stream().findFirst().orElse(null);
    }
}
