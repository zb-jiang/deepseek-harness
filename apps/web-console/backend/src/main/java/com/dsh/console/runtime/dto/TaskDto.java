package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;

/**
 * Flowable runtime task DTO。
 *
 * <p>对应 Flowable REST {@code GET /process-api/runtime/tasks} 返回的 data 数组元素,
 * 字段名按 Flowable 7 OSS REST 文档对齐。Web Console 后端透传,不做语义加工。
 *
 * @param id                   任务 id
 * @param name                 任务名(对应 BPMN userTask name)
 * @param assignee             办理人(可空,候选组任务未 claim 前为 null)
 * @param owner                 owner(可空)
 * @param createTime            创建时间
 * @param dueDate               到期时间(可空,超时升级依赖,见 spec §7.8)
 * @param processInstanceId     所属实例 id
 * @param processDefinitionId   所属 procdef id
 * @param taskDefinitionKey     节点定义 key(BPMN userTask id)
 * @param description           描述(可空)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskDto(
    String id,
    String name,
    String assignee,
    String owner,
    OffsetDateTime createTime,
    OffsetDateTime dueDate,
    String processInstanceId,
    String processDefinitionId,
    String taskDefinitionKey,
    String description
) {
}
