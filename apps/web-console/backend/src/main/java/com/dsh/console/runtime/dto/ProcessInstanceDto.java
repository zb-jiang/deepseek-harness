package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 流程实例 DTO。
 *
 * <p>统一 runtime 实例和 historic 实例的字段。运行中实例{@code endTime}/{@code deleteReason}
 * 为 null;已结束实例补齐结束时间与终止原因(spec §14.6:用 {@code deleteReason} 区分结束类型)。
 *
 * <p>应用隔离元数据({@code workflowDefinitionId}/{@code appId}/{@code workflowName})由 Web Console
 * 后端在查实例时按 {@code processDefinitionId} 反查 {@code public.workflow_definitions} 补齐,
 * Flowable REST 不直接返回这些字段。
 *
 * @param id                    Flowable 实例 id
 * @param businessKey           业务键(可空)
 * @param processDefinitionId   Flowable procdef id
 * @param processDefinitionKey  procdef key(可空)
 * @param processDefinitionName procdef 名称(可空)
 * @param name                  实例名(可空)
 * @param startUserId           发起人 auth_subject(可空,Flowable runtime 是 userId 字符串)
 * @param startUserName         发起人显示名(从 {@code public.platform_users} 反查,可空)
 * @param startTime             启动时间
 * @param suspended             是否挂起(runtime 才有意义;historic 为 false)
 * @param ended                 是否已结束
 * @param deleteReason          终止原因(正常完成 null;管理员强制终止非 null)
 * @param endTime               结束时间(可空)
 * @param workflowDefinitionId  对应的本地 workflow_definitions.id(可空,反查失败为 null)
 * @param appId                 所属应用 id(可空)
 * @param workflowName          流程定义名(可空,便于前端展示)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProcessInstanceDto(
    String id,
    String businessKey,
    String processDefinitionId,
    String processDefinitionKey,
    String processDefinitionName,
    String name,
    String startUserId,
    String startUserName,
    OffsetDateTime startTime,
    boolean suspended,
    boolean ended,
    String deleteReason,
    OffsetDateTime endTime,
    UUID workflowDefinitionId,
    UUID appId,
    String workflowName
) {
}
