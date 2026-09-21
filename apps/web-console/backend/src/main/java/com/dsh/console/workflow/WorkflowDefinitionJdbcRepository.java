package com.dsh.console.workflow;

import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.workflow_definitions} 表数据访问(setup guide §5.5)。
 *
 * <p>草稿 BPMN XML 存 draft_bpmn_xml 字段;发布后指向 Flowable deployment_id + procdef_id。
 */
@Repository
public class WorkflowDefinitionJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, app_id, name, description, status, draft_bpmn_xml,
               published_deployment_id, published_procdef_id, published_bpmn_xml,
               bpmn_process_key,
               created_at, created_by, updated_at, updated_by
        FROM public.workflow_definitions
        """;

    private final JdbcClient jdbcClient;

    public WorkflowDefinitionJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public Optional<WorkflowDefinitionDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(this::mapRow)
            .optional();
    }

    /**
     * 按 Flowable procdef id 反查(spec §13.4:流程实例必属一个 procdef,procdef 全局唯一
     * 只属于一个流程定义,流程定义必属一个应用)。
     *
     * <p>Web Console runtime 模块查实例时按 procdefId 反查应用归属用。仅匹配当前发布
     * 版本;重新发布过的旧版本实例会 miss,调用方应以 {@link #findByBpmnProcessKey}
     * (key 跨版本稳定)回退。
     */
    public Optional<WorkflowDefinitionDto> findByProcdefId(String procdefId) {
        if (procdefId == null || procdefId.isBlank()) {
            return Optional.empty();
        }
        return jdbcClient.sql(SELECT_BASE + " WHERE published_procdef_id = :procdefId")
            .param("procdefId", procdefId)
            .query(this::mapRow)
            .optional();
    }

    /**
     * 按 BPMN process key 反查(历史实例归属解析的回退路径)。
     *
     * <p>同一流程定义历次发布的 procdefId 各不相同,但 process key 不变;key 在表内
     * 唯一(发布校验拒绝重复 key),取最新一行。不过滤 status:流程停用/归档后,
     * 其历史实例仍需解析出应用归属。
     */
    public Optional<WorkflowDefinitionDto> findByBpmnProcessKey(String bpmnProcessKey) {
        if (bpmnProcessKey == null || bpmnProcessKey.isBlank()) {
            return Optional.empty();
        }
        return jdbcClient.sql(
                SELECT_BASE + " WHERE bpmn_process_key = :key ORDER BY updated_at DESC LIMIT 1")
            .param("key", bpmnProcessKey)
            .query(this::mapRow)
            .optional();
    }

    /**
     * 批量按 procdef id 反查(实例列表归属解析:一次列表内的全部 procdefId 一次查完)。
     *
     * <p>远端 Supabase RTT 高,逐实例单查(列表 N+1)在连接池上限下会占满连接拖垮
     * 整个后端;列表解析必须走本批量方法。procdefId 全局唯一,DISTINCT ON 仅防
     * 脏数据重复行(取 updated_at 最新)。
     */
    public Map<String, WorkflowDefinitionDto> findByProcdefIds(Collection<String> procdefIds) {
        if (procdefIds == null || procdefIds.isEmpty()) {
            return Map.of();
        }
        return jdbcClient.sql("""
                SELECT DISTINCT ON (published_procdef_id)
                       id, app_id, name, description, status, draft_bpmn_xml,
                       published_deployment_id, published_procdef_id, published_bpmn_xml,
                       bpmn_process_key, created_at, created_by, updated_at, updated_by
                FROM public.workflow_definitions
                WHERE published_procdef_id = ANY(:ids)
                ORDER BY published_procdef_id, updated_at DESC
                """)
            .param("ids", procdefIds.toArray(new String[0]))
            .query(this::mapRow)
            .list()
            .stream()
            .collect(Collectors.toMap(WorkflowDefinitionDto::publishedProcdefId, wf -> wf));
    }

    /**
     * 批量按 BPMN process key 反查(历史实例归属解析的回退路径,同 {@link #findByProcdefIds}
     * 的批量版)。同 key 多行(理论上发布校验已拒绝)时取 updated_at 最新一行。
     */
    public Map<String, WorkflowDefinitionDto> findByBpmnProcessKeys(Collection<String> keys) {
        if (keys == null || keys.isEmpty()) {
            return Map.of();
        }
        return jdbcClient.sql("""
                SELECT DISTINCT ON (bpmn_process_key)
                       id, app_id, name, description, status, draft_bpmn_xml,
                       published_deployment_id, published_procdef_id, published_bpmn_xml,
                       bpmn_process_key, created_at, created_by, updated_at, updated_by
                FROM public.workflow_definitions
                WHERE bpmn_process_key = ANY(:keys)
                ORDER BY bpmn_process_key, updated_at DESC
                """)
            .param("keys", keys.toArray(new String[0]))
            .query(this::mapRow)
            .list()
            .stream()
            .collect(Collectors.toMap(WorkflowDefinitionDto::bpmnProcessKey, wf -> wf));
    }

    /**
     * 列某应用下所有 published 状态的流程定义(用于按 appId 过滤运行中实例时拿 procdefId 集合)。
     */
    public List<WorkflowDefinitionDto> listPublishedByApp(UUID appId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE app_id = :appId AND status = 'published' ORDER BY created_at DESC")
            .param("appId", appId)
            .query(this::mapRow)
            .list();
    }

    /**
     * 全部 published 流程(slim 视图,join applications 取应用名)。
     *
     * <p>员工端/管理台"可发起流程"清单的 system_admin 全量路径。
     */
    public List<com.dsh.console.runtime.dto.StartableWorkflowDto> listStartableAll() {
        return jdbcClient.sql("""
                SELECT w.id, w.name, w.description, w.app_id, a.name AS app_name
                FROM public.workflow_definitions w
                JOIN public.applications a ON a.id = w.app_id
                WHERE w.status = 'published'
                ORDER BY a.name, w.created_at DESC
                """)
            .query((rs, rowNum) -> new com.dsh.console.runtime.dto.StartableWorkflowDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("description"),
                rs.getObject("app_id", UUID.class),
                rs.getString("app_name")))
            .list();
    }

    /**
     * 应用集合内的全部 published 流程(slim 视图,join applications 取应用名)。
     *
     * <p>员工端/管理台"可发起流程"清单用;空集合直接返回空列表(IN () 非法)。
     */
    public List<com.dsh.console.runtime.dto.StartableWorkflowDto> listStartableByAppIds(Collection<UUID> appIds) {
        if (appIds == null || appIds.isEmpty()) {
            return List.of();
        }
        return jdbcClient.sql("""
                SELECT w.id, w.name, w.description, w.app_id, a.name AS app_name
                FROM public.workflow_definitions w
                JOIN public.applications a ON a.id = w.app_id
                WHERE w.status = 'published' AND w.app_id IN (:appIds)
                ORDER BY a.name, w.created_at DESC
                """)
            .param("appIds", appIds)
            .query((rs, rowNum) -> new com.dsh.console.runtime.dto.StartableWorkflowDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("description"),
                rs.getObject("app_id", UUID.class),
                rs.getString("app_name")))
            .list();
    }

    public List<WorkflowDefinitionDto> listByApp(UUID appId) {
        return jdbcClient.sql(SELECT_BASE + " WHERE app_id = :appId ORDER BY created_at DESC")
            .param("appId", appId)
            .query(this::mapRow)
            .list();
    }

    public List<WorkflowDefinitionDto> list(String statusFilter, int offset, int limit) {
        if (statusFilter == null || statusFilter.isBlank()) {
            return jdbcClient.sql(SELECT_BASE + " ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
                .param("limit", limit)
                .param("offset", offset)
                .query(this::mapRow)
                .list();
        }
        return jdbcClient.sql(SELECT_BASE + " WHERE status = :status ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("status", statusFilter)
            .param("limit", limit)
            .param("offset", offset)
            .query(this::mapRow)
            .list();
    }

    /**
     * 列全部已发布且有发布版 BPMN XML 快照的流程定义。
     *
     * <p>DSH backend task skill 归属聚合用(setup guide §13.2):只认发布版快照,
     * 不解析草稿。加列之前已发布的流程无快照,不计入。
     */
    public List<WorkflowDefinitionDto> listPublishedWithXml() {
        return jdbcClient.sql(
                SELECT_BASE + " WHERE status = 'published' AND published_bpmn_xml IS NOT NULL")
            .query(this::mapRow)
            .list();
    }

    /**
     * 已发布流程快照的版本戳:published 行的 max(updated_at),供聚合缓存做失效判定。
     *
     * <p>backend profile 心跳高频调 skill 归属聚合,不能每次拉全部发布 XML 重解析
     * ({@link #listPublishedWithXml()} 大字段 + DOM);任何发布/停用/编辑都会推进
     * updated_at。无 published 行返回 empty(调用方以 epoch 前占位缓存空结果)。
     */
    public Optional<java.time.OffsetDateTime> maxPublishedUpdatedAt() {
        return jdbcClient.sql(
                "SELECT max(updated_at) FROM public.workflow_definitions "
                    + "WHERE status = 'published' AND published_bpmn_xml IS NOT NULL")
            .query(java.time.OffsetDateTime.class)
            .optional();
    }

    public UUID create(UUID appId, String name, String description, UUID createdBy) {
        return jdbcClient.sql("""
            INSERT INTO public.workflow_definitions (app_id, name, description, status, created_by)
            VALUES (:appId, :name, :description, 'draft', :createdBy)
            RETURNING id
            """)
            .param("appId", appId)
            .param("name", name)
            .param("description", description)
            .param("createdBy", createdBy)
            .query(UUID.class)
            .single();
    }

    public int updateDraftBpmnXml(UUID id, String bpmnXml, UUID updatedBy) {
        return jdbcClient.sql("""
            UPDATE public.workflow_definitions
            SET draft_bpmn_xml = :bpmnXml, updated_at = now(), updated_by = :updatedBy
            WHERE id = :id AND status IN ('draft', 'published', 'disabled')
            """)
            .param("id", id)
            .param("bpmnXml", bpmnXml)
            .param("updatedBy", updatedBy)
            .update();
    }

    public int markPublished(UUID id, String deploymentId, String procdefId, String publishedBpmnXml,
                             String bpmnProcessKey, UUID updatedBy) {
        return jdbcClient.sql("""
            UPDATE public.workflow_definitions
            SET status = 'published', published_deployment_id = :deploymentId,
                published_procdef_id = :procdefId, published_bpmn_xml = :publishedBpmnXml,
                bpmn_process_key = :bpmnProcessKey,
                updated_at = now(), updated_by = :updatedBy
            WHERE id = :id AND status IN ('draft', 'published', 'disabled')
            """)
            .param("id", id)
            .param("deploymentId", deploymentId)
            .param("procdefId", procdefId)
            .param("publishedBpmnXml", publishedBpmnXml)
            .param("bpmnProcessKey", bpmnProcessKey)
            .param("updatedBy", updatedBy)
            .update();
    }

    public int setStatus(UUID id, String status) {
        return jdbcClient.sql("UPDATE public.workflow_definitions SET status = :status WHERE id = :id")
            .param("id", id)
            .param("status", status)
            .update();
    }

    public int updateMeta(UUID id, String name, String description, UUID updatedBy) {
        return jdbcClient.sql("""
            UPDATE public.workflow_definitions
            SET name = :name, description = :description,
                updated_at = now(), updated_by = :updatedBy
            WHERE id = :id AND status != 'archived'
            """)
            .param("id", id)
            .param("name", name)
            .param("description", description)
            .param("updatedBy", updatedBy)
            .update();
    }

    private WorkflowDefinitionDto mapRow(java.sql.ResultSet rs, long rowNum) throws java.sql.SQLException {
        return new WorkflowDefinitionDto(
            rs.getObject("id", UUID.class),
            rs.getObject("app_id", UUID.class),
            rs.getString("name"),
            rs.getString("description"),
            rs.getString("status"),
            rs.getString("draft_bpmn_xml"),
            rs.getString("published_deployment_id"),
            rs.getString("published_procdef_id"),
            rs.getString("published_bpmn_xml"),
            rs.getString("bpmn_process_key"),
            rs.getObject("created_at", java.time.OffsetDateTime.class),
            rs.getObject("created_by", UUID.class),
            rs.getObject("updated_at", java.time.OffsetDateTime.class),
            rs.getObject("updated_by", UUID.class)
        );
    }
}
