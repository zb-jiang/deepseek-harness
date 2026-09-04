package com.dsh.console.workflow.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 修改流程定义元数据请求。
 *
 * @param name        流程定义名
 * @param description 描述(可空)
 */
public record UpdateWorkflowMetaRequest(
    @NotBlank
    String name,
    String description
) {
}
