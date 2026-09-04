package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshExtensionProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * DSH 任务 DTO,Flowable 任务 + 节点 dsh 元数据,供 task-api 消费。
 *
 * <p>对应 SPEC §4.11 Task 的产品抽象对象;Flowable {@code ACT_RU_TASK} + task-local 变量
 * {@code dsh_node_meta} 拼装而来。DSH enterprise profile 的 task-api 拿到后用于:
 * <ul>
 *   <li>列表展示待办中心;</li>
 *   <li>点击待办时用 {@code dshMeta} 创建新会话,取任务指令与 skill 引用
 *       ({@code dshMeta.userPrompt()} / {@code dshMeta.skillRefs()})。</li>
 * </ul>
 *
 * @param id                   Flowable 任务 id(ACT_RU_TASK.ID_)
 * @param processInstanceId    Flowable 实例 id
 * @param processDefinitionId  Flowable 流程定义 id(procdefId)
 * @param taskDefinitionKey    BPMN 节点 id(SPEC §4.8 WorkflowNodeDefinition.id)
 * @param name                任务名称(BPMN userTask name)
 * @param assignee           当前处理人 user.id(Supabase Auth sub);null 表示未认领
 * @param createTime         创建时间(ISO 8601 字符串)
 * @param dshMeta           节点 dsh 元数据 POJO;可能为 null(节点未配置 dsh extensionElements)
 * @param nodeId            dsh_node_id 变量值,同 {@link #taskDefinitionKey};冗余存便于消费方
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskDto(
    String id,
    String processInstanceId,
    String processDefinitionId,
    String taskDefinitionKey,
    String name,
    String assignee,
    String createTime,
    DshExtensionProperties dshMeta,
    String nodeId
) {
}
