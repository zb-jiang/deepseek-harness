package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.UUID;

/**
 * 可发起流程清单项(员工端/管理台发起入口用,slim 视图)。
 *
 * <p>与 {@link com.dsh.console.workflow.dto.WorkflowDefinitionDto} 的差异:
 * 不携带 BPMN XML 等管理面重字段,追加应用名便于员工跨应用辨认流程。
 *
 * @param id          流程定义 id(workflow_definitions.id)
 * @param name        流程名
 * @param description 描述(可空)
 * @param appId       所属应用 id
 * @param appName     所属应用名
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StartableWorkflowDto(
    UUID id,
    String name,
    String description,
    UUID appId,
    String appName
) {
}
