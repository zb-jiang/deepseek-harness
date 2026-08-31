package com.dsh.console.workflow.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 流程定义 DTO,对应 {@code public.workflow_definitions} 表(setup guide §5.5)。
 *
 * @param id                       主键 UUID
 * @param appId                    所属应用 ID
 * @param name                     流程定义名
 * @param description              描述(可空)
 * @param status                   状态:draft / published / disabled / archived
 * @param draftBpmnXml             草稿 BPMN XML(可空,首次创建时无)
 * @param publishedDeploymentId    发布后 Flowable deployment ID
 * @param publishedProcdefId        发布后 Flowable procdef ID
 * @param createdAt                创建时间
 * @param createdBy                创建人
 * @param updatedAt                更新时间
 * @param updatedBy                更新人
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WorkflowDefinitionDto(
    UUID id,
    UUID appId,
    String name,
    String description,
    String status,
    String draftBpmnXml,
    String publishedDeploymentId,
    String publishedProcdefId,
    OffsetDateTime createdAt,
    UUID createdBy,
    OffsetDateTime updatedAt,
    UUID updatedBy
) {
}
