package com.dsh.flowable.listener;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * BPMN 节点 dsh: extensionElements 解析后的元数据。
 *
 * 设计变更:不再引入 inputSchema / routingRule。
 * - 上游字段(输入)直接从 BPMN 流程变量树读取,无需单独声明;
 * - 节点的产出(输出)仍需声明 outputSchema——DSH agent 据此校验 complete 输出结构;
 * - 条件分支路由走 BPMN 原生机制(SequenceFlow 上的 conditionExpression)。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DshExtensionProperties(
    AssignmentRule assignmentRule,
    String outputSchema,
    String systemPrompt,
    String userPrompt,
    List<String> skillRefs,
    ActionPolicy actionPolicy
) {

    /**
     * 人工节点责任规则。
     *
     * @param candidateRoleId  候选角色 id(app_roles.id);按 §6.6 角色继承展开
     * @param taskStrategy     处理策略:single | countersign | sequential
     */
    public record AssignmentRule(String candidateRoleId, String taskStrategy) {}

    /**
     * 节点允许的人工动作和策略。
     *
     * @param timeoutPolicy  超时升级策略;nullable 表示不超时
     * @param sodRules       职责分离规则集合;空列表表示无 SoD 约束
     */
    public record ActionPolicy(TimeoutPolicy timeoutPolicy, List<SodRule> sodRules) {}

    /**
     * 超时升级策略。
     *
     * @param duration            ISO-8601 持续时长(如 PT24H)
     * @param escalateToRoleId    升级目标角色 id
     * @param escalateToUserId    升级目标用户 id;nullable 表示升级到角色
     */
    public record TimeoutPolicy(String duration, String escalateToRoleId, String escalateToUserId) {}

    /**
     * 职责分离规则。
     *
     * @param type not-applicant | mutex-node | countersign-distinct
     */
    public record SodRule(String type) {}
}
