package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 流程实例业务日志条目 DTO,供 {@code GET /dsh/history/process-log} 返回。
 *
 * <p>数据来源:引擎磁盘上的实例日志文件 {@code logs/process/<实例id>.log}
 * (由 {@link com.dsh.flowable.delegate.ProcessLog} 写入,backend task / service task
 * 等 delegate 调用产生)。端点逐行解析为结构化条目;
 * 不符合行格式的行(历史残留/异常写入)降级为 raw 原文条目,不丢内容。
 *
 * @param timestamp    日志时间({@code yyyy-MM-dd HH:mm:ss.SSS});raw 条目为 null
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
