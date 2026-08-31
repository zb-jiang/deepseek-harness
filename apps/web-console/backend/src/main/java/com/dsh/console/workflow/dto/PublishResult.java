package com.dsh.console.workflow.dto;

import java.util.UUID;

/**
 * 发布结果。
 *
 * @param workflowDefinitionId  本地 workflow_definitions.id
 * @param deploymentId          Flowable deployment ID
 * @param procdefId             Flowable procdef ID
 */
public record PublishResult(
    UUID workflowDefinitionId,
    String deploymentId,
    String procdefId
) {
}
