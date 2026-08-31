package com.dsh.console.workflow.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 保存草稿 BPMN XML 请求。
 *
 * @param draftBpmnXml  BPMN XML 内容(含 dsh: extensionElements)
 */
public record UpdateBpmnXmlRequest(
    @NotBlank
    String draftBpmnXml
) {
}
