package com.dsh.flowable.listener;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * BPMN 节点 dsh: extensionElements 解析后的元数据。
 *
 * 设计变更(design 2026-09-01):
 * - 不再引入 inputSchema / routingRule / outputSchema / systemPrompt / taskStrategy;
 * - 上游字段(输入)直接从 BPMN 流程变量树读取;
 * - 任务指令只有一段 userPrompt,输出 JSON 格式直接写在 prompt 文本里;
 * - 单人/会签/串签由 BPMN 原生 multiInstanceLoopCharacteristics 表达;
 * - 条件分支路由走 BPMN 原生机制(SequenceFlow 上的 conditionExpression)。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DshExtensionProperties(
    AssignmentRule assignmentRule,
    VotingRule votingRule,
    String userPrompt,
    List<String> skillRefs,
    ActionPolicy actionPolicy,
    List<OutputMapping> outputMappings,
    List<DshContextVariable> contextVariables,
    BackendTask backendTask
) {

    /**
     * 人工节点责任规则(design 2026-09-19:范围 × 目标角色)。
     *
     * <p>互斥语义由 {@link DshBpmnExtensionParser} 解析时归一化、web-console 发布校验
     * 严格把守:{@code virtualRole} 非空时(隐含同行政线)忽略 {@code candidateRoleId} /
     * {@code orgScope} / {@code fixedUnitId};实体角色时 {@code orgScope} 缺省=全公司
     * (存量流程行为不变)。
     *
     * @param candidateRoleId  实体候选角色 id(app_roles.id);虚拟角色时为 null
     * @param orgScope         组织范围:sameLine(同行政线) / fixedUnit(指定部门) /
     *                         global(全公司);null=缺省全公司(存量兼容)
     * @param virtualRole      虚拟角色:parent / grandparent / child / grandchild;
     *                         待办分配锚定申请人、超时升级锚定当前审批人
     * @param fixedUnitId      指定部门 id(org_units.id);orgScope=fixedUnit 时必填
     */
    public record AssignmentRule(String candidateRoleId, String orgScope, String virtualRole, String fixedUnitId) {}

    /**
     * 会签计票规则(design 2026-09-15):按多实例每份提交的表决变量值聚合票数,
     * 引擎按票数自动生成完成条件(达到通过/否决票数提前收,剩余待办自动删除)。
     *
     * @param variable    表决变量名(必须是本节点输出映射 target 根变量,发布校验保证)
     * @param passValue   记一票同意的值;非空且不等于它记一票否决
     * @param passCount   通过票数阈值(>=1,发布校验保证)
     * @param rejectCount 否决票数阈值;null 表示不设否决阈值(否决票只计数,投满自然结束)
     */
    public record VotingRule(String variable, String passValue, Integer passCount, Integer rejectCount) {}

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
     * <p>升级目标优先级(引擎 {@link com.dsh.flowable.delegate.DshTaskEscalationDelegate}
     * 对齐):用户 ID &gt; 虚拟角色 &gt; 实体角色;三选一,其余属性不写。</p>
     *
     * @param duration                ISO-8601 持续时长(如 PT24H)
     * @param escalateToRoleId         升级目标实体角色 id
     * @param escalateToUserId        升级目标用户 id
     * @param escalateToVirtualRole   升级目标虚拟角色(parent/grandparent);锚定当前审批人
     *                                 (design 2026-09-19 §5.2 双锚点:升级=审批人的上级接管);
     *                                 审批人已是组织顶点时保持原审批人并记审计变量
     * @param escalateOrgScope        实体角色的审批范围:global(缺省全公司,null 同)/
     *                                 sameLine(申请人行政线内)/fixedUnit(指定部门);
     *                                 仅 escalateToRoleId 非空时有意义
     * @param escalateFixedUnitId     指定部门 id(org_units.id);
     *                                 仅 escalateOrgScope=fixedUnit 时必填
     */
    public record TimeoutPolicy(String duration, String escalateToRoleId, String escalateToUserId,
                                String escalateToVirtualRole, String escalateOrgScope,
                                String escalateFixedUnitId) {}

    /**
     * 职责分离规则。
     *
     * @param type not-applicant | mutex-node | countersign-distinct
     */
    public record SodRule(String type) {}

    /**
     * userTask 输出映射:员工提交 JSON 写入流程上下文变量的规则,提交端点执行。
     *
     * @param source 提交 JSON 的顶层字段或点路径;null/空串 = 整体提交 JSON
     * @param target 上下文变量名,可带 {@code .field} 深入路径
     */
    public record OutputMapping(String source, String target) {}

    /**
     * DSH backend task 标记(design 2026-09-14 §6.1;多实例扩展 2026-09-15):
     * 存在于 ServiceTask 的 extensionElements 即识别为后端任务节点,
     * userPrompt/skillRefs/outputMappings/votingRule 与 userTask 同构复用。
     *
     * @param backendProfileUrl 单实例调用的 backend profile 实例 URL(发布校验保证非空)
     * @param profileUrls       多实例时每实例绑定的 profile 列表(第 i 实例用第 i 个,
     *                          发布校验保证长度等于 loopCardinality;空表示非多实例)
     */
    public record BackendTask(String backendProfileUrl, List<String> profileUrls) {}
}
