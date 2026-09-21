package com.dsh.flowable.delegate;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshCandidateResolver;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.dsh.flowable.repository.DshMembershipRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository;
import java.util.List;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.TaskService;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.flowable.task.api.Task;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * userTask 超时升级委托：将任务 candidate / assignee 切换到升级目标。
 *
 * <p>由 {@link com.dsh.flowable.listener.DshBpmnParseHandler} 在部署时动态附加到
 * 每个配置了 {@code dsh:timeoutPolicy} 的 userTask 之后,通过 non-interrupting boundary
 * timer 触发。timer 触发时原 userTask 仍在执行,本 delegate 找到该任务并升级。
 *
 * <p>升级目标(design 2026-09-19 扩展虚拟角色,锚定当前审批人——升级本义是
 * "审批人超时,审批人的上级接管"):
 * <ul>
 *   <li>{@code escalateToUserId}:直接将任务 assignee 设为该用户;</li>
 *   <li>{@code escalateToRoleId}:查询该角色下的 active 用户,设为 candidateUsers;</li>
 *   <li>{@code escalateToVirtualRole}(parent/grandparent):按当前审批人(多实例逐任务
 *       assignee)的解析依据部门走 {@link DshCandidateResolver} 链式解析——锚点优先
 *       任务局部变量 {@code dsh_assignment_org_unit}(design 决策 13),缺失回退按
 *       assignee 反查 org_unit_members 映射表且要求唯一(0/多个报错);审批人已是组织
 *       顶点时无处可升,保持原审批人并记审计变量 {@code dsh_escalationTop_<taskId>}
 *       (§5.3 升级到顶行,不自动通过、不报错)。</li>
 *   <li>同时清除原 candidateUsers / candidateGroups / assignee,避免多人同时可见。</li>
 * </ul>
 *
 * <p>多实例场景下同一 taskDefinitionKey 可能有多个 active task,本 delegate 会全部升级;
 * 虚拟角色按每个任务自己的 assignee 独立解析(逐人锚定)。
 */
@Component("dshTaskEscalationDelegate")
public class DshTaskEscalationDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(DshTaskEscalationDelegate.class);

    private static final String ESCALATION_TASK_SUFFIX = "_timeout_escalation";

    /** 升级到顶审计变量前缀(design 2026-09-19 §5.3),完整变量名 {@code dsh_escalationTop_<taskDefKey>}。 */
    public static final String ESCALATION_TOP_VARIABLE_PREFIX = "dsh_escalationTop_";

    private final RepositoryService repositoryService;
    private final TaskService taskService;
    private final DshMembershipRepository membershipRepository;
    private final DshBpmnExtensionParser extensionParser;
    private final DshCandidateResolver candidateResolver;
    private final DshOrgUnitRepository orgUnitRepository;

    public DshTaskEscalationDelegate(RepositoryService repositoryService,
                                     TaskService taskService,
                                     DshMembershipRepository membershipRepository,
                                     DshBpmnExtensionParser extensionParser,
                                     DshCandidateResolver candidateResolver,
                                     DshOrgUnitRepository orgUnitRepository) {
        this.repositoryService = repositoryService;
        this.taskService = taskService;
        this.membershipRepository = membershipRepository;
        this.extensionParser = extensionParser;
        this.candidateResolver = candidateResolver;
        this.orgUnitRepository = orgUnitRepository;
    }

    @Override
    public void execute(DelegateExecution execution) {
        String escalationTaskId = execution.getCurrentActivityId();
        if (escalationTaskId == null || !escalationTaskId.endsWith(ESCALATION_TASK_SUFFIX)) {
            return;
        }
        String originalTaskDefKey = escalationTaskId.substring(
            0,
            escalationTaskId.length() - ESCALATION_TASK_SUFFIX.length()
        );

        UserTask userTask = findOriginalUserTask(execution.getProcessDefinitionId(), originalTaskDefKey);
        if (userTask == null) {
            return;
        }

        DshExtensionProperties props = extensionParser.parse(userTask);
        if (props == null || props.actionPolicy() == null || props.actionPolicy().timeoutPolicy() == null) {
            return;
        }
        DshExtensionProperties.TimeoutPolicy policy = props.actionPolicy().timeoutPolicy();
        if (!StringUtils.hasText(policy.escalateToRoleId())
            && !StringUtils.hasText(policy.escalateToUserId())
            && !StringUtils.hasText(policy.escalateToVirtualRole())) {
            return;
        }

        List<Task> tasks = taskService.createTaskQuery()
            .processInstanceId(execution.getProcessInstanceId())
            .taskDefinitionKey(originalTaskDefKey)
            .active()
            .list();

        for (Task task : tasks) {
            escalateTask(execution, task, originalTaskDefKey, policy);
        }
    }

    private UserTask findOriginalUserTask(String processDefinitionId, String taskDefKey) {
        BpmnModel bpmnModel = repositoryService.getBpmnModel(processDefinitionId);
        if (bpmnModel == null) {
            return null;
        }
        return (UserTask) bpmnModel.getFlowElement(taskDefKey);
    }

    private void escalateTask(DelegateExecution execution, Task task, String originalTaskDefKey,
                              DshExtensionProperties.TimeoutPolicy policy) {
        // 虚拟角色路径:先解析升级目标,审批人已是组织顶点时保持原审批人(不进入清空逻辑)
        if (StringUtils.hasText(policy.escalateToVirtualRole())) {
            escalateToVirtual(execution, task, originalTaskDefKey, policy.escalateToVirtualRole());
            return;
        }

        String taskId = task.getId();
        // 先解除当前办理人与原候选集,避免升级后旧办理人仍能看到任务
        taskService.setAssignee(taskId, null);
        taskService.getIdentityLinksForTask(taskId).stream()
            .filter(link -> "candidate".equals(link.getType()))
            .forEach(link -> {
                if (StringUtils.hasText(link.getUserId())) {
                    taskService.deleteCandidateUser(taskId, link.getUserId());
                } else if (StringUtils.hasText(link.getGroupId())) {
                    taskService.deleteCandidateGroup(taskId, link.getGroupId());
                }
            });

        if (StringUtils.hasText(policy.escalateToUserId())) {
            taskService.setAssignee(taskId, policy.escalateToUserId());
            return;
        }

        if (StringUtils.hasText(policy.escalateToRoleId())) {
            List<String> userIds = membershipRepository.findActiveUserIdsByRoleId(policy.escalateToRoleId());
            for (String userId : userIds) {
                taskService.addCandidateUser(taskId, userId);
            }
        }
    }

    /**
     * 虚拟角色升级(锚定当前审批人):按解析依据部门链式解析升级目标;
     * 审批人已是组织顶点 → 无处可升,保持原审批人并记审计变量。
     */
    private void escalateToVirtual(DelegateExecution execution, Task task, String originalTaskDefKey,
                                   String virtualRole) {
        String assignee = task.getAssignee();
        if (!StringUtils.hasText(assignee)) {
            log.info("任务 {} 无 assignee,无法按虚拟角色 {} 锚定升级,保持原状",
                task.getId(), virtualRole);
            return;
        }
        String anchorOrgUnitId = resolveAnchorOrgUnit(task, assignee);
        DshCandidateResolver.Resolution resolution = candidateResolver.resolveForEscalation(
            virtualRole, anchorOrgUnitId, assignee);
        if (resolution.structuralTopAutoPass()) {
            // 审批人已是组织顶点:保持原审批人并记审计(§5.3,不自动通过、不报错)
            log.info("任务 {} 的审批人 {} 已是组织顶点,升级到顶任务保留", task.getId(), assignee);
            execution.setVariable(ESCALATION_TOP_VARIABLE_PREFIX + originalTaskDefKey, true);
            return;
        }
        List<String> targets = resolution.candidates();
        if (targets.isEmpty()) {
            log.info("任务 {} 的虚拟角色 {} 解析为空,保持原审批人", task.getId(), virtualRole);
            return;
        }
        // 单人升级直接指派(链式虚拟角色解析结果至多一人,防御多候选走 candidateUsers)
        String taskId = task.getId();
        taskService.getIdentityLinksForTask(taskId).stream()
            .filter(link -> "candidate".equals(link.getType()))
            .forEach(link -> {
                if (StringUtils.hasText(link.getUserId())) {
                    taskService.deleteCandidateUser(taskId, link.getUserId());
                } else if (StringUtils.hasText(link.getGroupId())) {
                    taskService.deleteCandidateGroup(taskId, link.getGroupId());
                }
            });
        if (targets.size() == 1) {
            taskService.setAssignee(taskId, targets.get(0));
        } else {
            for (String userId : targets) {
                taskService.addCandidateUser(taskId, userId);
            }
        }
    }

    /**
     * 解析升级锚点部门(design 决策 13):优先任务局部变量
     * {@code dsh_assignment_org_unit}(派发时快照的解析依据部门);缺失(global 场景/
     * 存量任务)回退按 assignee 反查 org_unit_members 映射表并要求唯一——
     * 0 个或多个部门抛错(§5.3 锚点歧义行,fail loud 不静默猜)。
     */
    private String resolveAnchorOrgUnit(Task task, String assignee) {
        Object local = task.getTaskLocalVariables()
            .get(DshTaskListener.TASK_VARIABLE_ASSIGNMENT_ORG_UNIT);
        if (local instanceof String anchorOrgUnitId && StringUtils.hasText(anchorOrgUnitId)) {
            return anchorOrgUnitId;
        }
        List<String> orgUnitIds = orgUnitRepository.findOrgUnitIdsByAuthSubject(assignee);
        if (orgUnitIds.size() != 1) {
            throw new IllegalStateException("审批人 " + assignee + " 在组织映射表中"
                + (orgUnitIds.isEmpty() ? "没有部门" : "属于 " + orgUnitIds.size() + " 个部门")
                + ",无法定位升级链(审批人组织身份不唯一)");
        }
        return orgUnitIds.get(0);
    }
}
