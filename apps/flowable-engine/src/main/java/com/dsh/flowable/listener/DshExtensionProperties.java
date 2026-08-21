package com.dsh.flowable.listener;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * BPMN 节点 {@code dsh:} extensionElements 解析后的元数据。
 *
 * <p>对应 SPEC §4.8 WorkflowNodeDefinition 的 DSH 特有字段,承载于 BPMN XML 的
 * {@code dsh:} extensionElements 命名空间,由 {@link DshTaskListener} 在 task create 事件
 * 触发时从 BPMN model 解析并注入 task 变量,供 task-api 读取。
 *
 * <p>字段不含 {@code id}/{@code nodeType}/{@code name} 等 Flowable 自身管理的属性,
 * 只承载 DSH 特有元数据。{@code taskStrategy} 仅 {@code human} 节点适用;
 * {@code auto} 节点用 ServiceTask,通过 {@link com.dsh.flowable.delegate.DshServiceTaskDelegate}
 * 直接消费,不通过 task 变量。
 *
 * @param assignmentRule  人工节点责任规则(SPEC §4.8 #5);仅 {@code human} 节点
 * @param inputSchema     JSON Schema 字符串,定义节点消费的上游字段契约
 * @param outputSchema    JSON Schema 字符串,定义节点提交时必须产出的结构化字段(参见 §7.8)
 * @param systemPrompt    会话级 system prompt(DSH preset section 注入,用户不改);nullable
 * @param userPrompt      预填会话首条 user message;可含 {@code {{upstream.field}}} 占位符
 * @param skillRefs       节点用到的 skill 名称列表;供员工 PC 定时任务预装(SPEC §9.4)
 * @param actionPolicy    节点允许的人工动作和策略,含超时升级与 SoD 规则;nullable
 * @param routingRule     路由规则;定义节点完成后的流向(条件分支等);nullable
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DshExtensionProperties(
    AssignmentRule assignmentRule,
    String inputSchema,
    String outputSchema,
    String systemPrompt,
    String userPrompt,
    List<String> skillRefs,
    ActionPolicy actionPolicy,
    RoutingRule routingRule
) {

    /**
     * 人工节点责任规则。
     *
     * @param candidateRoleId  候选角色 id(对应 {@code app_roles.id});按 §6.6 角色继承展开
     * @param taskStrategy     处理策略:single(单人,§6.1) | countersign(会签,§6.2) | sequential(串签,§6.3)
     */
    public record AssignmentRule(String candidateRoleId, String taskStrategy) {
    }

    /**
     * 节点允许的人工动作和策略。
     *
     * @param timeoutPolicy  超时升级策略(SPEC §6.8);nullable 表示不超时
     * @param sodRules      职责分离规则集合(SPEC §6.7);空列表表示无 SoD 约束
     */
    public record ActionPolicy(TimeoutPolicy timeoutPolicy, List<SodRule> sodRules) {
    }

    /**
     * 超时升级策略(SPEC §6.8)。
     *
     * @param duration          ISO-8601 持续时长(如 {@code PT24H})
     * @param escalateToRoleId  升级目标角色 id;按 §6.6 角色继承展开候选
     * @param escalateToUserId 升级目标用户 id;nullable 表示升级到角色
     */
    public record TimeoutPolicy(String duration, String escalateToRoleId, String escalateToUserId) {
    }

    /**
     * 职责分离规则(SPEC §6.7)。
     *
     * @param type 规则类型:{@code not-applicant}(审批人不得为申请人) |
     *             {@code mutex-node}(同实例互斥节点) |
     *             {@code countersign-distinct}(会签人不重复)
     */
    public record SodRule(String type) {
    }

    /**
     * 路由规则。
     *
     * @param expression 路由表达式(如读取 outputSchema 中某字段决定下游分支)
     */
    public record RoutingRule(String expression) {
    }
}
