package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * DSH 历史活动 DTO,供历史/审计端点返回。
 *
 * <p>"活动"(Activity)是 BPMN 节点实例级的执行历史,涵盖所有节点类型(userTask/serviceTask/
 * startEvent/endEvent/gateway 等),用于审计"流程走过了哪些节点、何时走过、停留多久"。
 * 与 {@link HistoricTaskDto} 的区别:历史任务只覆盖 UserTask,历史活动覆盖全部 BPMN 节点。
 *
 * <p>对应 SPEC §10.1 退回/跳转(§7.4)审计所需信息:回溯流程执行路径,判断在哪个网关
 * 分支选择了哪个出口,以及自动节点(serviceTask)是否执行成功。
 *
 * <p>数据来源:Flowable {@code ACT_HI_ACTINST}。需要 history level >= AUDIT(本服务在
 * {@link com.dsh.flowable.config.FlowableConfig} 配 FULL,已满足)。
 *
 * @param id                   活动实例 id
 * @param processInstanceId    实例 id
 * @param processDefinitionId  流程定义 id
 * @param activityId           BPMN 节点 def key(等于 userTask 的 taskDefinitionKey)
 * @param activityName         节点名称(BPMN name 属性)
 * @param activityType         节点类型({@code userTask}/{@code serviceTask}/{@code startEvent}/
 *                             {@code endEvent}/{@code exclusiveGateway} 等)
 * @param assignee            userTask 的处理人;非 userTask 节点为 null
 * @param startTime           进入节点时间(ISO 8601)
 * @param endTime             离开节点时间(ISO 8601);null 表示当前停留在该节点(进行中)
 * @param durationInMillis   在节点上的停留耗时(毫秒);null 表示进行中
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HistoricActivityDto(
    String id,
    String processInstanceId,
    String processDefinitionId,
    String activityId,
    String activityName,
    String activityType,
    String assignee,
    String startTime,
    String endTime,
    Long durationInMillis
) {
}
