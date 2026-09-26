package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 流程实例业务日志条目 DTO(引擎实例日志文件的结构化回读)。
 *
 * <p>来源引擎 {@code GET /dsh/history/process-log}:引擎侧
 * {@code logs/process/<实例id>.log}(由 backend task / service task 等 delegate 写入)
 * 逐行解析为结构化条目;不符合行格式的行降级为 raw 原文条目。
 * 与前端流程日志表(时间戳/节点名称/日志详情)及画布节点点击高亮(activityId 匹配)对接。
 *
 * @param timestamp    日志时间(引擎侧 {@code yyyy-MM-dd HH:mm:ss.SSS});raw 条目为 null
 * @param activityId   产生日志的 BPMN 节点 id(与画布元素 id 同一匹配键);raw 条目为 null
 * @param activityName 节点名称(BPMN name 属性,未配 name 时为 null);raw 条目为 null
 * @param message      日志消息(消息本身含换行时已并入同一条目)
 * @param raw          原始行文本;仅解析失败的行非 null
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProcessLogEntryDto(
    String timestamp,
    String activityId,
    String activityName,
    String message,
    String raw
) {
}
