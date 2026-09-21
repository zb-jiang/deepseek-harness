package com.dsh.flowable.delegate;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshCandidateResolver;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.dsh.flowable.repository.DshMembershipRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.TaskService;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.task.api.Task;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 虚拟角色超时升级的锚点解析单测(design 决策 13):任务局部变量
 * {@code dsh_assignment_org_unit} 优先;缺失回退 org_unit_members 映射表且要求唯一,
 * 0 个或多个部门 fail loud(§5.3 锚点歧义行)。
 */
class DshTaskEscalationDelegateTest {

    private static final String TASK_ID = "task-1";
    private static final String DEPT_A = "unit-a";
    private static final String DEPT_B = "unit-b";
    private static final String ZHANGSAN = "user-zhangsan"; // 审批人(A 部门负责人)
    private static final String LAOZHOU = "user-laozhou";   // 升级目标(华东区负责人)

    private final RepositoryService repositoryService = mock(RepositoryService.class);
    private final TaskService taskService = mock(TaskService.class);
    private final DshBpmnExtensionParser extensionParser = mock(DshBpmnExtensionParser.class);
    private final DshCandidateResolver candidateResolver = mock(DshCandidateResolver.class);
    private final DshOrgUnitRepository orgUnitRepository = mock(DshOrgUnitRepository.class);
    private final DshTaskEscalationDelegate delegate = new DshTaskEscalationDelegate(
        repositoryService, taskService, mock(DshMembershipRepository.class),
        extensionParser, candidateResolver, orgUnitRepository);

    private final DelegateExecution execution = mock(DelegateExecution.class);
    private final Task task = mock(Task.class);

    @BeforeEach
    void setUp() {
        BpmnModel bpmnModel = mock(BpmnModel.class);
        UserTask userTask = new UserTask();
        when(execution.getCurrentActivityId()).thenReturn("approve_timeout_escalation");
        when(execution.getProcessInstanceId()).thenReturn("proc-1");
        when(execution.getProcessDefinitionId()).thenReturn("procdef-1");
        when(repositoryService.getBpmnModel("procdef-1")).thenReturn(bpmnModel);
        when(bpmnModel.getFlowElement("approve")).thenReturn(userTask);
        DshExtensionProperties props = new DshExtensionProperties(
            null, null, null, List.of(),
            new DshExtensionProperties.ActionPolicy(
                new DshExtensionProperties.TimeoutPolicy("PT1H", null, null, "parent"), null),
            List.of(), List.of(), null);
        when(extensionParser.parse(userTask)).thenReturn(props);

        org.flowable.task.api.TaskQuery taskQuery = mock(org.flowable.task.api.TaskQuery.class);
        when(taskService.createTaskQuery()).thenReturn(taskQuery);
        when(taskQuery.processInstanceId("proc-1")).thenReturn(taskQuery);
        when(taskQuery.taskDefinitionKey("approve")).thenReturn(taskQuery);
        when(taskQuery.active()).thenReturn(taskQuery);
        when(taskQuery.list()).thenReturn(List.of(task));

        when(task.getId()).thenReturn(TASK_ID);
        when(task.getAssignee()).thenReturn(ZHANGSAN);
        when(taskService.getIdentityLinksForTask(TASK_ID)).thenReturn(List.of());
    }

    @Test
    void escalationPrefersTaskLocalAssignmentOrgUnit() {
        // 决策 13:派发时快照的解析依据部门优先,不再反查映射表
        when(task.getTaskLocalVariables()).thenReturn(
            Map.of(DshTaskListener.TASK_VARIABLE_ASSIGNMENT_ORG_UNIT, DEPT_A));
        when(candidateResolver.resolveForEscalation("parent", DEPT_A, ZHANGSAN))
            .thenReturn(new DshCandidateResolver.Resolution(List.of(LAOZHOU), Map.of(), false));

        delegate.execute(execution);

        verify(orgUnitRepository, never()).findOrgUnitIdsByAuthSubject(anyString());
        verify(taskService).setAssignee(TASK_ID, LAOZHOU);
    }

    @Test
    void escalationFallsBackToSoleMappedDepartment() {
        // 局部变量缺失(global 场景/存量任务):回退映射表,唯一部门直接用
        when(task.getTaskLocalVariables()).thenReturn(Map.of());
        when(orgUnitRepository.findOrgUnitIdsByAuthSubject(ZHANGSAN)).thenReturn(List.of(DEPT_A));
        when(candidateResolver.resolveForEscalation("parent", DEPT_A, ZHANGSAN))
            .thenReturn(new DshCandidateResolver.Resolution(List.of(LAOZHOU), Map.of(), false));

        delegate.execute(execution);

        verify(taskService).setAssignee(TASK_ID, LAOZHOU);
    }

    @Test
    void escalationFailsLoudWhenAssigneeHasNoDepartment() {
        // §5.3 锚点歧义:回退时 0 个部门报错,不静默猜
        when(task.getTaskLocalVariables()).thenReturn(Map.of());
        when(orgUnitRepository.findOrgUnitIdsByAuthSubject(ZHANGSAN)).thenReturn(List.of());

        assertThatThrownBy(() -> delegate.execute(execution))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("没有部门")
            .hasMessageContaining("组织身份不唯一");
    }

    @Test
    void escalationFailsLoudWhenAssigneeHasMultipleDepartments() {
        // §5.3 锚点歧义:回退时多个部门报错,不静默取某一个
        when(task.getTaskLocalVariables()).thenReturn(Map.of());
        when(orgUnitRepository.findOrgUnitIdsByAuthSubject(ZHANGSAN))
            .thenReturn(List.of(DEPT_A, DEPT_B));

        assertThatThrownBy(() -> delegate.execute(execution))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("属于 2 个部门")
            .hasMessageContaining("组织身份不唯一");
    }
}
