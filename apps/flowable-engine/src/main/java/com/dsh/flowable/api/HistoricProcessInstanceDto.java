package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * DSH 历史流程实例 DTO,供历史/审计端点返回。
 *
 * <p>对应 SPEC §10.1 审计接口要求:查询流程实例的发起人、起止时间、结束状态等审计关键信息,
 * 用于追溯流程全生命周期。运行中实例(endTime=null)同样从 {@code ACT_HI_PROCINST} 拿,
 * 用于"运行中实例列表"等场景。
 *
 * <p>数据来源:Flowable {@code ACT_HI_PROCINST} + {@code ACT_RE_PROCDEF}(取流程定义名称/key)。
 *
 * <p>关于结束类型:Flowable 7 OSS 不在 historic 接口暴露正式的 endState 枚举
 * (那是 Flowable 商业版扩展);正常完成的实例 {@code deleteReason} 为 null,
 * 被管理员/系统强制终止的实例 {@code deleteReason} 非 null。消费方据此区分。
 *
 * @param id                     实例 id
 * @param processDefinitionId    流程定义 id
 * @param processDefinitionKey    流程定义 key(BPMN process id)
 * @param processDefinitionName  流程定义名称(BPMN process name)
 * @param processDefinitionVersion 流程定义版本号
 * @param businessKey           业务 key(由发起方传入);nullable
 * @param startUserId           发起人 user.id(SPEC §6.6 申请人;用于 SoD not-applicant 规则)
 * @param startTime             发起时间(ISO 8601)
 * @param endTime               结束时间(ISO 8601);null 表示运行中
 * @param durationInMillis     总耗时(毫秒);null 表示运行中
 * @param deleteReason          删除原因(管理员强制终止时填);null 表示正常完成
 * @param superProcessInstanceId 父实例 id(本实例由父实例 callActivity 触发时);nullable
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HistoricProcessInstanceDto(
    String id,
    String processDefinitionId,
    String processDefinitionKey,
    String processDefinitionName,
    Integer processDefinitionVersion,
    String businessKey,
    String startUserId,
    String startTime,
    String endTime,
    Long durationInMillis,
    String deleteReason,
    String superProcessInstanceId
) {
}
