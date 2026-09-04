package com.dsh.console.runtime.dto;

/**
 * 启动表单变量项(按已部署 BPMN 的 start-param 声明生成)。
 *
 * @param name         变量名
 * @param type         声明类型(八种之一)
 * @param description  说明文本
 * @param required     true = 无初始值兜底,启动必填;false = 有初始值可留空
 */
public record StartFormVariableDto(String name, String type, String description,
                                   boolean required) {
}
