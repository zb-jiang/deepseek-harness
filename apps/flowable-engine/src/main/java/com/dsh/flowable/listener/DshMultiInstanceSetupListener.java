package com.dsh.flowable.listener;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.ExecutionListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import com.dsh.flowable.repository.DshMembershipRepository;

/**
 * 为配置了 {@code dsh:assignmentRule}(候选角色或虚拟角色/组织范围,design 2026-09-19)
 * 或 {@code dsh:votingRule} 的多实例 UserTask 做运行时前置注入。
 *
 * <p>在 userTask 节点 {@code start} 事件触发时执行,早于多实例拆分:
 * <ol>
 *   <li>解析 {@code dsh:assignmentRule},经 {@link DshCandidateResolver} 按范围×角色
 *       组合矩阵计算候选 user.id 列表(锚定申请人):
 *       <ul>
 *         <li>存量配置(仅 candidateRoleId,无 orgScope/virtualRole)走全公司直查,
 *             行为与引入组织维度前完全一致;</li>
 *         <li>虚拟角色/组织范围路径中「结构到顶」返回自动通过信号:写空候选列表
 *             (0 实例多实例由引擎直接收口)并记审计变量 {@code dsh_autoPassed_<taskId>}
 *             (§5.3 向上到顶自动通过);</li>
 *         <li>数据缺失/空扇出/整条线无该职位由 resolver 抛错,实例失败不静默。</li>
 *       </ul></li>
 *   <li>应用 SoD 规则过滤(若 {@code dsh:actionPolicy.sodRules} 非空,在解析结果上执行);</li>
 *   <li>把过滤后的列表写入流程变量 {@code dsh_candidates_<taskId>},供多实例
 *       {@code loopDataInputRef} 使用。</li>
 *   <li>组织维度路径把候选的部门归属(SoD 过滤后)写入流程变量
 *       {@code dsh_assignment_orgs_<taskId>}(design 决策 13),由
 *       {@link DshTaskListener} 在任务创建时写成任务局部变量
 *       {@code dsh_assignment_org_unit}(超时升级锚点)。</li>
 *   <li>配置了 {@code dsh:votingRule}(design 2026-09-15)时初始化计票变量
 *       {@code dsh_passCount_<taskId>} / {@code dsh_rejectCount_<taskId>} 为 0。</li>
 * </ol>
 *
 * <p>多实例本身的 {@code loopDataInputRef / inputDataItem / assignee} 与计票完成条件
 * 由 {@link DshBpmnParseHandler} 在部署时自动补齐。
 *
 * <p>该 listener 只处理多实例任务;非多实例任务仍由 {@link DshTaskListener} 在
 * {@code create} 事件里维护 {@code candidateUsers}。
 */
@Component("dshMultiInstanceSetupListener")
public class DshMultiInstanceSetupListener implements ExecutionListener {

    private static final Logger log = LoggerFactory.getLogger(DshMultiInstanceSetupListener.class);

    /** 多实例 collection 变量前缀,完整变量名为 {@code dsh_candidates_<taskId>}。 */
    public static final String CANDIDATES_VARIABLE_PREFIX = "dsh_candidates_";

    /** 多实例元素变量名,每个实例的 assignee 由该变量驱动。 */
    public static final String CANDIDATE_ITEM_VARIABLE = "dshCandidateUserId";

    /**
     * 候选部门归属流程变量前缀(design 决策 13),完整变量名
     * {@code dsh_assignment_orgs_<taskId>},值为 assignee → 解析依据部门 id;
     * {@link DshTaskListener} 派发时据此写任务局部变量
     * {@code dsh_assignment_org_unit}(超时升级锚点)。global 场景不写本变量。
     */
    public static final String ASSIGNMENT_ORGS_VARIABLE_PREFIX = "dsh_assignment_orgs_";

    /** 「到顶自动通过」审计变量前缀(design 2026-09-19 §5.3),完整变量名 {@code dsh_autoPassed_<taskId>}。 */
    public static final String AUTO_PASS_VARIABLE_PREFIX = "dsh_autoPassed_";

    /** 实例变量名:申请人主部门 id(web-console start 时注入,design 2026-09-19 §5.1)。 */
    public static final String PROCESS_VARIABLE_APPLICANT_ORG_UNIT_ID = "dsh_applicant_org_unit_id";

    private final DshExtensionResolver resolver;
    private final DshMembershipRepository membershipRepository;
    private final DshSodFilter sodFilter;
    private final DshCandidateResolver candidateResolver;

    public DshMultiInstanceSetupListener(DshExtensionResolver resolver,
                                          DshMembershipRepository membershipRepository,
                                          DshSodFilter sodFilter,
                                          DshCandidateResolver candidateResolver) {
        this.resolver = resolver;
        this.membershipRepository = membershipRepository;
        this.sodFilter = sodFilter;
        this.candidateResolver = candidateResolver;
    }

    @Override
    public void notify(DelegateExecution execution) {
        String procdefId = execution.getProcessDefinitionId();
        String taskDefKey = execution.getCurrentActivityId();
        if (procdefId == null || taskDefKey == null) {
            return;
        }

        UserTask userTask = resolver.findUserTask(procdefId, taskDefKey);
        if (userTask == null || userTask.getLoopCharacteristics() == null) {
            return;
        }

        DshExtensionProperties props = resolver.resolveTaskProperties(procdefId, taskDefKey);
        if (props == null) {
            return;
        }

        // 会签计票计数变量初始化(design 2026-09-15):0 起算
        if (props.votingRule() != null) {
            execution.setVariable(
                DshBpmnParseHandler.PASS_COUNT_VARIABLE_PREFIX + taskDefKey, 0L);
            execution.setVariable(
                DshBpmnParseHandler.REJECT_COUNT_VARIABLE_PREFIX + taskDefKey, 0L);
        }

        DshExtensionProperties.AssignmentRule rule = props.assignmentRule();
        DshCandidateResolver.Resolution resolution = resolveCandidates(execution, taskDefKey, rule);
        if (resolution == null) {
            return;
        }
        List<String> candidates = resolution.candidates();

        String applicantUserId = (String) execution
            .getVariable(DshSodFilter.PROCESS_VARIABLE_APPLICANT_USER_ID);
        List<String> filtered = sodFilter.filter(
            candidates,
            props.actionPolicy() == null ? null : props.actionPolicy().sodRules(),
            execution.getProcessInstanceId(),
            taskDefKey,
            applicantUserId
        );

        execution.setVariable(CANDIDATES_VARIABLE_PREFIX + taskDefKey, filtered);

        // 决策 13:候选部门归属(SoD 过滤后重建)→ 派发时写任务局部变量
        Map<String, String> assignmentOrgUnits = resolution.assignmentOrgUnits();
        if (!assignmentOrgUnits.isEmpty()) {
            Map<String, String> orgsForCandidates = new LinkedHashMap<>();
            for (String user : filtered) {
                String orgUnitId = assignmentOrgUnits.get(user);
                if (orgUnitId != null) {
                    orgsForCandidates.putIfAbsent(user, orgUnitId);
                }
            }
            if (!orgsForCandidates.isEmpty()) {
                execution.setVariable(ASSIGNMENT_ORGS_VARIABLE_PREFIX + taskDefKey, orgsForCandidates);
            }
        }
    }

    /**
     * 按 assignmentRule 计算候选解析结果。
     *
     * @return 解析结果(候选 + 部门归属);null 表示无 assignmentRule 配置(维持现状,不写变量);
     *         空候选表示 0 实例(到顶自动通过或全公司空角色,存量兼容)
     */
    private DshCandidateResolver.Resolution resolveCandidates(DelegateExecution execution, String taskDefKey,
                                                              DshExtensionProperties.AssignmentRule rule) {
        if (rule == null) {
            return null;
        }
        if (rule.virtualRole() != null || rule.orgScope() != null) {
            // 组织维度路径(design 2026-09-19):resolver 统一矩阵解析,锚定申请人
            DshCandidateResolver.Resolution resolution = candidateResolver.resolveForApplicant(
                rule,
                (String) execution.getVariable(PROCESS_VARIABLE_APPLICANT_ORG_UNIT_ID),
                (String) execution.getVariable(DshSodFilter.PROCESS_VARIABLE_APPLICANT_USER_ID)
            );
            if (resolution == null) {
                return null;
            }
            if (resolution.structuralTopAutoPass()) {
                // 结构到顶:空候选(0 实例直接收口)+ 审计变量留痕(§5.3)
                log.info("userTask {} 在实例 {} 上解析到组织顶点,自动通过",
                    taskDefKey, execution.getProcessInstanceId());
                execution.setVariable(AUTO_PASS_VARIABLE_PREFIX + taskDefKey, true);
            }
            return resolution;
        }
        // 存量路径:candidateRoleId 全公司直查(行为与引入组织维度前完全一致)
        String roleId = rule.candidateRoleId();
        if (roleId == null || roleId.isBlank()) {
            return null;
        }
        return DshCandidateResolver.Resolution.of(membershipRepository.findActiveUserIdsByRoleId(roleId));
    }
}
