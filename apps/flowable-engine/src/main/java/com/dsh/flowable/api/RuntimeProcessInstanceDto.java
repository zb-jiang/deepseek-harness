package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * DSH 运行中流程实例 DTO,供 {@link DshRuntimeController} 返回。
 *
 * <p>Flowable 官方 runtime REST representation 不带 processDefinitionKey 等定义字段,
 * Web Console 的应用归属反查需要 key(旧版本运行实例按 procdefId 反查会 miss)。
 * 本 DTO 直接取自 runtime {@code ProcessInstance} 接口自带的定义字段,补齐官方响应缺口。
 *
 * @param id                        实例 id
 * @param processDefinitionId       流程定义 id(部署版本级)
 * @param processDefinitionKey      流程定义 key(BPMN process id,跨版本稳定)
 * @param processDefinitionName     流程定义名称
 * @param processDefinitionVersion  流程定义版本号
 * @param businessKey               业务 key(由发起方传入);nullable
 * @param name                      实例名;nullable
 * @param startUserId               发起人 user.id(Supabase Auth user.id);nullable
 * @param startTime                 发起时间(ISO 8601)
 * @param suspended                 实例是否挂起
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RuntimeProcessInstanceDto(
    String id,
    String processDefinitionId,
    String processDefinitionKey,
    String processDefinitionName,
    Integer processDefinitionVersion,
    String businessKey,
    String name,
    String startUserId,
    String startTime,
    boolean suspended
) {
}
