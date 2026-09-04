package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;

/**
 * 历史活动 DTO(实例执行路径回溯)。
 *
 * <p>来源引擎 {@code GET /dsh/history/activities}:覆盖全部 BPMN 节点类型
 * (userTask/serviceTask/startEvent/endEvent/gateway/sequenceFlow 等),
 * 供详情页活动路径图(节点高亮)与活动时间线渲染。
 *
 * @param id                活动实例 id
 * @param activityId        BPMN 节点/连线 def key(与画布 element id 对齐,用于高亮)
 * @param activityName      节点名称(BPMN name 属性)
 * @param activityType      节点类型({@code userTask}/{@code sequenceFlow} 等)
 * @param assignee          userTask 的处理人;非 userTask 节点为 null
 * @param assigneeName      处理人显示名(从 {@code public.platform_users} 反查,可空)
 * @param startTime         进入节点时间
 * @param endTime           离开节点时间;null 表示当前停留在该节点(进行中)
 * @param durationInMillis  在节点上的停留耗时(毫秒);null 表示进行中
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HistoricActivityDto(
    String id,
    String activityId,
    String activityName,
    String activityType,
    String assignee,
    String assigneeName,
    OffsetDateTime startTime,
    OffsetDateTime endTime,
    Long durationInMillis
) {
}
