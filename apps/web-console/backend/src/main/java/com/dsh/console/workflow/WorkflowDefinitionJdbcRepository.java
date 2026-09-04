package com.dsh.console.workflow;

import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
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
               published_deployment_id, published_procdef_id,
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
     * <p>Web Console runtime 模块查实例时按 procdefId 反查应用归属用。
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
     * 列某应用下所有 published 状态的流程定义(用于按 appId 过滤运行中实例时拿 procdefId 集合)。
     */
    public List<WorkflowDefinitionDto> listPublishedByApp(UUID appId) {
        return jdbcClient.sql(
                SELECT_BASE + " WHERE app_id = :appId AND status = 'published' ORDER BY created_at DESC")
            .param("appId", appId)
            .query(this::mapRow)
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

    public int markPublished(UUID id, String deploymentId, String procdefId, UUID updatedBy) {
        return jdbcClient.sql("""
            UPDATE public.workflow_definitions
            SET status = 'published', published_deployment_id = :deploymentId,
                published_procdef_id = :procdefId, updated_at = now(), updated_by = :updatedBy
            WHERE id = :id AND status IN ('draft', 'published', 'disabled')
            """)
            .param("id", id)
            .param("deploymentId", deploymentId)
            .param("procdefId", procdefId)
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
            rs.getObject("created_at", java.time.OffsetDateTime.class),
            rs.getObject("created_by", UUID.class),
            rs.getObject("updated_at", java.time.OffsetDateTime.class),
            rs.getObject("updated_by", UUID.class)
        );
    }
}
