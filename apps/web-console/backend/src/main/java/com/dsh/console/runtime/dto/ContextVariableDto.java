package com.dsh.console.runtime.dto;

import java.util.List;

/**
 * 流程上下文声明项(已部署 BPMN 的 dsh:contextVariables,供强制完成弹窗的变量清单)。
 *
 * @param name        变量名或字段名
 * @param type        声明类型(八种之一)
 * @param description 说明文本
 * @param fields      object 类型的字段清单(递归);非 object 为空清单
 */
public record ContextVariableDto(String name, String type, String description,
                                 List<ContextVariableDto> fields) {
}
