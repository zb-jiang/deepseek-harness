package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshExtensionProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * DSH 历史任务 DTO,供历史/审计端点返回。
 *
 * <p>对应 SPEC §10.1 审计接口要求:查询流程实例中所有已处理/进行中的任务,
 * 包含处理人、起止时间、耗时、删除原因等审计关键信息。
 *
 * <p>数据来源:Flowable {@code ACT_HI_TASKINST} + task-local 变量(通过
 * {@code includeTaskLocalVariables()} 一次查齐,避免 N+1)。{@code dshMeta} 沿用
 * {@link DshExtensionProperties} POJO,与运行时 {@link TaskDto} 保持一致,方便
 * 审计页面对比运行时和历史节点的 dsh 元数据。
 *
 * @param id                   历史任务 id(等于运行时 task id)
 * @param processInstanceId    实例 id
 * @param processDefinitionId  流程定义 id
 * @param taskDefinitionKey    BPMN 节点 def key
 * @param name                 任务名称(BPMN userTask name)
 * @param assignee            处理人 user.id;null 表示未认领
 * @param startTime           创建时间(ISO 8601)
 * @param endTime             完成时间(ISO 8601);null 表示进行中
 * @param durationInMillis    处理耗时(毫秒);null 表示进行中或未计算
 * @param deleteReason        删除/终止原因(由管理员干预或流程级 cancel 触发);nullable
 * @param dshMeta            节点 dsh 元数据 POJO;null 表示节点未配置 dsh extensionElements
 * @param nodeId             dsh_node_id 变量值,同 {@link #taskDefinitionKey};冗余存便于消费方
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HistoricTaskDto(
    String id,
    String processInstanceId,
    String processDefinitionId,
    String taskDefinitionKey,
    String name,
    String assignee,
    String startTime,
    String endTime,
    Long durationInMillis,
    String deleteReason,
    DshExtensionProperties dshMeta,
    String nodeId
) {
}
