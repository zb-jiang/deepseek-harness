package com.dsh.flowable.listener;

import java.util.List;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.ExecutionListener;
import org.springframework.stereotype.Component;
import com.dsh.flowable.repository.DshMembershipRepository;

/**
 * 为配置了 {@code dsh:assignmentRule.candidateRoleId} 的多实例 UserTask 注入候选人变量。
 *
 * <p>在 userTask 节点 {@code start} 事件触发时执行,早于多实例拆分:
 * <ol>
 *   <li>解析 {@code dsh:assignmentRule.candidateRoleId},查 {@code public.app_memberships}
 *       拿到角色下直接成员 user.id 列表;</li>
 *   <li>应用 SoD 规则过滤(若 {@code dsh:actionPolicy.sodRules} 非空);</li>
 *   <li>把过滤后的列表写入流程变量 {@code dsh_candidates_<taskId>},供多实例
 *       {@code loopDataInputRef} 使用。</li>
 * </ol>
 *
 * <p>多实例本身的 {@code loopDataInputRef / inputDataItem / assignee} 由
 * {@link DshBpmnParseHandler} 在部署时自动补齐,设计师只需在 bpmn-js 扳手菜单选择
 * 并行/串行并填写完成条件即可。
 *
 * <p>该 listener 只处理多实例任务;非多实例任务仍由 {@link DshTaskListener} 在
 * {@code create} 事件里维护 {@code candidateUsers}。
 */
@Component("dshMultiInstanceSetupListener")
public class DshMultiInstanceSetupListener implements ExecutionListener {

    /** 多实例 collection 变量前缀,完整变量名为 {@code dsh_candidates_<taskId>}。 */
    public static final String CANDIDATES_VARIABLE_PREFIX = "dsh_candidates_";

    /** 多实例元素变量名,每个实例的 assignee 由该变量驱动。 */
    public static final String CANDIDATE_ITEM_VARIABLE = "dshCandidateUserId";

    private final DshExtensionResolver resolver;
    private final DshMembershipRepository membershipRepository;
    private final DshSodFilter sodFilter;

    public DshMultiInstanceSetupListener(DshExtensionResolver resolver,
                                          DshMembershipRepository membershipRepository,
                                          DshSodFilter sodFilter) {
        this.resolver = resolver;
        this.membershipRepository = membershipRepository;
        this.sodFilter = sodFilter;
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
        if (props == null || props.assignmentRule() == null) {
            return;
        }

        String roleId = props.assignmentRule().candidateRoleId();
        if (roleId == null || roleId.isBlank()) {
            return;
        }

        List<String> candidates = membershipRepository.findActiveUserIdsByRoleId(roleId);
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
    }
}
