package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;

/**
 * Flowable 任务 DTO(运行时 + 历史统一)。
 *
 * <p>运行时来源 Flowable REST {@code GET /process-api/runtime/tasks};历史来源引擎
 * {@code GET /dsh/history/tasks}(实例结束后详情页任务列表回退到历史查询)。
 * 运行时任务 {@code endTime}/{@code deleteReason} 为 null;历史任务补齐完成时间
 * 与删除/终止原因,前端据此渲染"已完成/已终止"状态。
 *
 * @param id                   任务 id
 * @param name                 任务名(对应 BPMN userTask name)
 * @param assignee             办理人 user.id(可空,候选组任务未 claim 前为 null)
 * @param assigneeName         办理人显示名(从 {@code public.platform_users} 反查,可空)
 * @param owner                 owner(可空)
 * @param createTime            创建时间
 * @param dueDate               到期时间(可空,超时升级依赖,见 spec §7.8)
 * @param processInstanceId     所属实例 id
 * @param processDefinitionId   所属 procdef id
 * @param taskDefinitionKey     节点定义 key(BPMN userTask id)
 * @param description           描述(可空)
 * @param endTime               完成时间(历史任务;运行中为 null)
 * @param deleteReason          删除/终止原因(历史任务被干预或实例终止时非 null)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskDto(
    String id,
    String name,
    String assignee,
    String assigneeName,
    String owner,
    OffsetDateTime createTime,
    OffsetDateTime dueDate,
    String processInstanceId,
    String processDefinitionId,
    String taskDefinitionKey,
    String description,
    OffsetDateTime endTime,
    String deleteReason
) {
}
