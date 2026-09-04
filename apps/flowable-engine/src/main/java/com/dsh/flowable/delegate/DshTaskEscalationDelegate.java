package com.dsh.flowable.delegate;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.repository.DshMembershipRepository;
import java.util.List;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.TaskService;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.flowable.task.api.Task;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * userTask 超时升级委托：将任务 candidate / assignee 切换到升级目标。
 *
 * <p>由 {@link com.dsh.flowable.listener.DshBpmnParseHandler} 在部署时动态附加到
 * 每个配置了 {@code dsh:timeoutPolicy} 的 userTask 之后,通过 non-interrupting boundary
 * timer 触发。timer 触发时原 userTask 仍在执行,本 delegate 找到该任务并升级。
 *
 * <p>升级逻辑:
 * <ul>
 *   <li>若配了 {@code escalateToUserId},直接将任务 assignee 设为该用户;</li>
 *   <li>若配了 {@code escalateToRoleId},查询该角色下的 active 用户,设为 candidateUsers;
 *   <li>同时清除原 candidateUsers / candidateGroups / assignee,避免多人同时可见。</li>
 * </ul>
 *
 * <p>多实例场景下同一 taskDefinitionKey 可能有多个 active task,本 delegate 会全部升级。
 */
@Component("dshTaskEscalationDelegate")
public class DshTaskEscalationDelegate implements JavaDelegate {

    private static final String ESCALATION_TASK_SUFFIX = "_timeout_escalation";

    private final RepositoryService repositoryService;
    private final TaskService taskService;
    private final DshMembershipRepository membershipRepository;
    private final DshBpmnExtensionParser extensionParser;

    public DshTaskEscalationDelegate(
        RepositoryService repositoryService,
        TaskService taskService,
        DshMembershipRepository membershipRepository,
        DshBpmnExtensionParser extensionParser
    ) {
        this.repositoryService = repositoryService;
        this.taskService = taskService;
        this.membershipRepository = membershipRepository;
        this.extensionParser = extensionParser;
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
        if (!StringUtils.hasText(policy.escalateToRoleId()) && !StringUtils.hasText(policy.escalateToUserId())) {
            return;
        }

        List<Task> tasks = taskService.createTaskQuery()
            .processInstanceId(execution.getProcessInstanceId())
            .taskDefinitionKey(originalTaskDefKey)
            .active()
            .list();

        for (Task task : tasks) {
            escalateTask(task, policy);
        }
    }

    private UserTask findOriginalUserTask(String processDefinitionId, String taskDefKey) {
        BpmnModel bpmnModel = repositoryService.getBpmnModel(processDefinitionId);
        if (bpmnModel == null) {
            return null;
        }
        return (UserTask) bpmnModel.getFlowElement(taskDefKey);
    }

    private void escalateTask(Task task, DshExtensionProperties.TimeoutPolicy policy) {
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
}
