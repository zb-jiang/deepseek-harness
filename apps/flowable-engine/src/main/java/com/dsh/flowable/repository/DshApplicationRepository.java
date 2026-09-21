package com.dsh.flowable.repository;

import java.util.Collection;
import java.util.Map;
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
 * <p>归属解析两级:先按 {@code published_procdef_id} 精确匹配;流程重新发布后
 * 仍运行在旧 procdef 上的实例精确匹配不上,回退按 {@code bpmn_process_key}
 * 匹配(procdefId 固定 {@code key:version:id} 格式,key 为第一段;web-console
 * 发布查重保证 bpmn_process_key 全局唯一,回退命中同一治理行、同一应用)。
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
     *         namespace 时返回 null
     */
    public String findSkillhubNamespaceByProcdefId(String procdefId) {
        if (procdefId == null || procdefId.isBlank()) {
            return null;
        }
        String exact = jdbcTemplate.query(
            "SELECT a.skillhub_namespace FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.published_procdef_id = ? LIMIT 1",
            (rs, rowNum) -> rs.getString(1),
            procdefId
        ).stream().findFirst().orElse(null);
        if (exact != null) {
            return exact;
        }
        String processKey = extractProcessKey(procdefId);
        if (processKey == null) {
            return null;
        }
        return jdbcTemplate.query(
            "SELECT a.skillhub_namespace FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.bpmn_process_key = ? LIMIT 1",
            (rs, rowNum) -> rs.getString(1),
            processKey
        ).stream().findFirst().orElse(null);
    }

    /**
     * 从 Flowable procdefId 解析 BPMN process key。
     *
     * @param procdefId 固定 {@code key:version:id} 格式(BPMN key 是 NCName,不含冒号)
     * @return key;格式不符合(缺冒号或首段为空)时返回 null,调用方按未命中处理
     */
    private static String extractProcessKey(String procdefId) {
        int separator = procdefId.indexOf(':');
        if (separator <= 0) {
            return null;
        }
        return procdefId.substring(0, separator);
    }

    /**
     * 批量查询流程定义所属应用 id(TaskDto.applicationId 的数据源)。
     *
     * <p>员工端凭 applicationId 定位该应用的知识库(design 2026-09-11 §6);归属口径与
     * {@link #findSkillhubNamespaceByProcdefId} 一致:先按 {@code published_procdef_id}
     * 精确 IN 匹配,旧发布实例回退按 {@code bpmn_process_key} IN 匹配。待办列表逐
     * procdef 单查在远端 DB 上是 N+1,本方法至多两次 IN 查完。
     *
     * @param procdefIds Flowable 流程定义 id 集合(PROC_DEF 表主键)
     * @return procdefId → 应用 id(UUID 字符串);未归属应用(两级都未命中)的 procdefId 不在 Map
     */
    public Map<String, String> findApplicationIdsByProcdefIds(Collection<String> procdefIds) {
        if (procdefIds == null || procdefIds.isEmpty()) {
            return Map.of();
        }
        Map<String, String> result = new java.util.HashMap<>();
        String placeholders = String.join(",", java.util.Collections.nCopies(procdefIds.size(), "?"));
        jdbcTemplate.query(
            "SELECT wd.published_procdef_id, a.id FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.published_procdef_id IN (" + placeholders + ")",
            rs -> {
                while (rs.next()) {
                    result.put(rs.getString(1), rs.getString(2));
                }
            },
            procdefIds.toArray());

        Map<String, String> keyByUnmatchedProcdef = new java.util.LinkedHashMap<>();
        for (String procdefId : procdefIds) {
            if (result.containsKey(procdefId)) {
                continue;
            }
            String processKey = extractProcessKey(procdefId);
            if (processKey != null) {
                keyByUnmatchedProcdef.put(procdefId, processKey);
            }
        }
        if (keyByUnmatchedProcdef.isEmpty()) {
            return result;
        }
        java.util.Collection<String> keys = new java.util.HashSet<>(keyByUnmatchedProcdef.values());
        String keyPlaceholders = String.join(",", java.util.Collections.nCopies(keys.size(), "?"));
        Map<String, String> applicationIdByKey = jdbcTemplate.query(
            "SELECT wd.bpmn_process_key, a.id FROM public.workflow_definitions wd "
                + "JOIN public.applications a ON a.id = wd.app_id "
                + "WHERE wd.bpmn_process_key IN (" + keyPlaceholders + ")",
            rs -> {
                Map<String, String> byKey = new java.util.HashMap<>();
                while (rs.next()) {
                    byKey.put(rs.getString(1), rs.getString(2));
                }
                return byKey;
            },
            keys.toArray());
        keyByUnmatchedProcdef.forEach((procdefId, processKey) -> {
            String applicationId = applicationIdByKey.get(processKey);
            if (applicationId != null) {
                result.put(procdefId, applicationId);
            }
        });
        return result;
    }
}
