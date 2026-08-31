package com.dsh.console.workflow.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.UUID;

/**
 * 创建流程定义请求(创建草稿;BPMN XML 通过 PUT 单独保存)。
 *
 * @param appId        所属应用 ID
 * @param name         流程定义名
 * @param description  描述(可空)
 */
public record CreateWorkflowRequest(
    UUID appId,
    @NotBlank
    String name,
    String description
) {
}
