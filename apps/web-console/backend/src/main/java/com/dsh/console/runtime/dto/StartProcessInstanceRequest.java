package com.dsh.console.runtime.dto;

import jakarta.validation.constraints.NotNull;
import java.util.Map;
import java.util.UUID;

/**
 * 启动流程实例请求。
 *
 * <p>V1 由 Web Console 后端发起实例启动(spec §6.3 + §7.7.4):
 * <ul>
 *   <li>{@code workflowDefinitionId} 必填,后端据此查 {@code public.workflow_definitions}
 *       拿 {@code published_procdef_id},并校验 status == published。</li>
 *   <li>应用隔离三变量由后端自动注入,调用方不需要传:
 *     <ul>
 *       <li>{@code dsh_applicant_user_id}:发起人流程身份(Supabase auth_subject,JWT sub,
 *       与引擎侧 assignee/候选人同一 ID 体系)</li>
 *       <li>{@code dsh_app_id}:应用 id</li>
 *       <li>{@code dsh_workflow_definition_id}:本 workflow_definition id</li>
 *     </ul>
 *   </li>
 *   <li>{@code variables} 是额外业务变量(可选,合并到上述隔离变量一起写入实例)。</li>
 * </ul>
 *
 * @param workflowDefinitionId 流程定义 id(必填,必为 published)
 * @param businessKey          业务键(可空,如订单号;便于按业务键查实例)
 * @param name                 实例名(可空,Flowable runtime instance.name)
 * @param variables            额外业务变量(可空)
 */
public record StartProcessInstanceRequest(
    @NotNull
    UUID workflowDefinitionId,
    String businessKey,
    String name,
    Map<String, Object> variables
) {
}
