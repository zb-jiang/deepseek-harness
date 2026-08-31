package com.dsh.console.workflow.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * BPMN 校验结果。
 *
 * <p>{@link com.dsh.console.workflow.BpmnValidationService#validate} 返回。
 *
 * @param valid     是否通过校验
 * @param errors    错误列表(校验失败时,可读描述;通过时为空)
 */
public record BpmnValidationResult(
    boolean valid,
    List<String> errors
) {
    public static BpmnValidationResult ok() {
        return new BpmnValidationResult(true, List.of());
    }

    public static BpmnValidationResult fail(String... errors) {
        return new BpmnValidationResult(false, List.of(errors));
    }

    public static BpmnValidationResult fail(List<String> errors) {
        return new BpmnValidationResult(false, new ArrayList<>(errors));
    }
}
