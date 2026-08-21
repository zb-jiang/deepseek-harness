package com.dsh.flowable.delegate;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * Flowable 引擎调用 DSH web profile 执行自动节点的请求体。
 *
 * <p>由 {@link DshServiceTaskDelegate} 在 ServiceTask 触发时构造,包含实例上下文与上游数据快照,
 * 供 DSH web profile 加载 skill / 调 LLM / 执行脚本时使用。
 *
 * @param processInstanceId   Flowable 实例 id
 * @param processDefinitionId Flowable 流程定义 id(procdefId)
 * @param activityId          当前 ServiceTask 在 BPMN 中的节点 id(nodeDefinitionId)
 * @param inputSnapshot       当前 execution 的全部变量(上游节点产出 + 实例上下文)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AutoNodeRequest(
    String processInstanceId,
    String processDefinitionId,
    String activityId,
    Map<String, Object> inputSnapshot
) {
}
