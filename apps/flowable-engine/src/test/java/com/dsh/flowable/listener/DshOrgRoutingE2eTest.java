package com.dsh.flowable.listener;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.flowable.repository.DshMembershipRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository.OrgUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.parse.BpmnParseHandler;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.flowable.validation.ProcessValidatorFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 组织维度审批路由端到端(design 2026-09-19 阶段2/5):真实 listener 链
 * (DshBpmnParseHandler → DshMultiInstanceSetupListener → DshCandidateResolver
 * → DshTaskListener)+ stub 组织/成员仓储,验证多实例 userTask 在六场景下的
 * 运行时派发、「到顶自动通过」边界(空候选 0 实例由引擎直接收口)与
 * 决策 13 的任务局部变量 dsh_assignment_org_unit(超时升级锚点)。
 */
class DshOrgRoutingE2eTest {

    private static final String ROOT = "unit-root";
    private static final String HUADONG = "unit-huadong";
    private static final String DEPT_A = "unit-a";
    private static final String FINANCE = "unit-finance";
    private static final String MAZONG = "user-mazong";
    private static final String LAOZHOU = "user-laozhou";
    private static final String ZHANGSAN = "user-zhangsan";
    private static final String QIANJIE = "user-qianjie";
    private static final String XIAOWANG = "user-xiaowang";
    private static final String ROLE_MANAGER = "role-manager";

    private ProcessEngine processEngine;
    private RuntimeService runtimeService;
    private TaskService taskService;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-org-routing-test-" + System.nanoTime());
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);

        configuration.setPreBpmnParseHandlers(
            new java.util.ArrayList<>(List.<BpmnParseHandler>of(new DshBpmnParseHandler())));
        configuration.setProcessValidator(
            new DshProcessValidator(new ProcessValidatorFactory().createDefaultProcessValidator()));

        DshOrgUnitRepository orgRepo = new DshOrgUnitRepository(null) {
            @Override
            public List<OrgUnit> loadAll() {
                return List.of(
                    new OrgUnit(ROOT, "总公司", null, MAZONG),
                    new OrgUnit(HUADONG, "华东区", ROOT, LAOZHOU),
                    new OrgUnit(DEPT_A, "A部门", HUADONG, ZHANGSAN),
                    new OrgUnit(FINANCE, "财务部", ROOT, QIANJIE)
                );
            }

            @Override
            public Map<String, List<String>> findRoleMembersByOrgUnitIds(String roleId, java.util.Collection<String> orgUnitIds) {
                // A 部门无经理成员:sameLine 实体角色须上翻华东区
                return ROLE_MANAGER.equals(roleId) && orgUnitIds.contains(HUADONG)
                    ? Map.of(HUADONG, List.of(LAOZHOU)) : Map.of();
            }
        };
        DshMembershipRepository memRepo = new DshMembershipRepository(null) {
            @Override
            public List<String> findActiveUserIdsByRoleId(String roleId) {
                return List.of(ZHANGSAN, LAOZHOU);
            }
        };
        DshCandidateResolver candidateResolver = new DshCandidateResolver(orgRepo, memRepo);

        org.flowable.engine.RepositoryService lazyRepositoryService =
            (org.flowable.engine.RepositoryService) java.lang.reflect.Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[]{org.flowable.engine.RepositoryService.class},
                (proxy, method, args) -> {
                    org.flowable.engine.RepositoryService real = realRepositoryService.get();
                    if (real == null) {
                        throw new IllegalStateException("repository service not ready");
                    }
                    try {
                        return method.invoke(real, args);
                    } catch (java.lang.reflect.InvocationTargetException e) {
                        throw e.getCause();
                    }
                });

        DshExtensionResolver resolver = new DshExtensionResolver(
            lazyRepositoryService, new DshBpmnExtensionParser(), new DshExtensionPropertiesCache());
        DshMultiInstanceSetupListener setupListener = new DshMultiInstanceSetupListener(
            resolver, memRepo, new DshSodFilter(null), candidateResolver);

        org.flowable.engine.TaskService lazyTaskService =
            (org.flowable.engine.TaskService) java.lang.reflect.Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[]{org.flowable.engine.TaskService.class},
                (proxy, method, args) -> {
                    org.flowable.engine.TaskService real = realTaskService.get();
                    if (real == null) {
                        throw new IllegalStateException("task service not ready");
                    }
                    try {
                        return method.invoke(real, args);
                    } catch (java.lang.reflect.InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
        DshTaskListener taskListener = new DshTaskListener(
            resolver, new com.fasterxml.jackson.databind.ObjectMapper(),
            new DshSodFilter(null), memRepo, candidateResolver, lazyTaskService);

        Map<Object, Object> beans = new HashMap<>();
        beans.put("dshTaskListener", taskListener);
        beans.put("dshMultiInstanceSetupListener", setupListener);
        configuration.setBeans(beans);

        processEngine = configuration.buildProcessEngine();
        runtimeService = processEngine.getRuntimeService();
        taskService = processEngine.getTaskService();
        realRepositoryService.set(processEngine.getRepositoryService());
        realTaskService.set(processEngine.getTaskService());
    }

    private final java.util.concurrent.atomic.AtomicReference<org.flowable.engine.RepositoryService>
        realRepositoryService = new java.util.concurrent.atomic.AtomicReference<>();

    private final java.util.concurrent.atomic.AtomicReference<org.flowable.engine.TaskService>
        realTaskService = new java.util.concurrent.atomic.AtomicReference<>();

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void virtualParentAssignsApplicantDepartmentHead() {
        deployProcess("dsh_parent_process", """
            <dsh:assignmentRule virtualRole="parent"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_parent_process", startVars(DEPT_A, XIAOWANG));
        List<Task> tasks = taskService.createTaskQuery().processInstanceId(instance.getId()).list();
        // 员工小王提交→A 部门负责人张三
        assertThat(tasks).extracting(Task::getAssignee).containsExactly(ZHANGSAN);
    }

    @Test
    void virtualParentAtTopAutoPassesNode() {
        deployProcess("dsh_parent_top_process", """
            <dsh:assignmentRule virtualRole="parent"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_parent_top_process", startVars(ROOT, MAZONG));
        // 马总(组织顶点)提交:到顶自动通过,0 实例,流程直接走到 end
        assertThat(taskService.createTaskQuery().processInstanceId(instance.getId()).count()).isZero();
        assertThat(runtimeService.createProcessInstanceQuery()
            .processInstanceId(instance.getId()).count()).isZero();
        // 流程已整体结束,审计变量从 history 读(运行时执行体已不存在)
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName(DshMultiInstanceSetupListener.AUTO_PASS_VARIABLE_PREFIX + "approve")
            .singleResult()
            .getValue())
            .isEqualTo(true);
    }

    @Test
    void virtualChildFansOutDirectChildrenHeads() {
        deployProcess("dsh_child_process", """
            <dsh:assignmentRule virtualRole="child"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_child_process", startVars(ROOT, MAZONG));
        // 总经理发文:直接子部门[华东,财务]负责人[老周,钱姐]各一份待办(会签)
        List<Task> tasks = taskService.createTaskQuery().processInstanceId(instance.getId()).list();
        assertThat(tasks).extracting(Task::getAssignee)
            .containsExactlyInAnyOrder(LAOZHOU, QIANJIE);
    }

    @Test
    void sameLineRoleGoesUpWhenOwnDepartmentLacksRole() {
        deployProcess("dsh_sameline_process", """
            <dsh:assignmentRule candidateRoleId="role-manager" orgScope="sameLine"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_sameline_process", startVars(DEPT_A, XIAOWANG));
        // A 部门无经理成员→上翻华东区找到老周(小王自己不是经理,未被跳过影响)
        List<Task> tasks = taskService.createTaskQuery().processInstanceId(instance.getId()).list();
        assertThat(tasks).extracting(Task::getAssignee).containsExactly(LAOZHOU);
    }

    @Test
    void legacyCandidateRoleWithoutOrgScopeKeepsGlobalBehavior() {
        // 存量回归:无 orgScope/virtualRole 的 candidateRoleId=全公司直查,行为不变
        deployProcess("dsh_legacy_process", """
            <dsh:assignmentRule candidateRoleId="role-any"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_legacy_process", startVars(DEPT_A, XIAOWANG));
        List<Task> tasks = taskService.createTaskQuery().processInstanceId(instance.getId()).list();
        assertThat(tasks).extracting(Task::getAssignee)
            .containsExactlyInAnyOrder(ZHANGSAN, LAOZHOU);
    }

    @Test
    void assignedTaskCarriesAssignmentOrgUnitLocalVariable() {
        // 决策13:派发时把解析依据部门写任务局部变量(超时升级锚点)
        deployProcess("dsh_assignment_org_process", """
            <dsh:assignmentRule virtualRole="parent"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_assignment_org_process", startVars(DEPT_A, XIAOWANG));
        Task task = taskService.createTaskQuery()
            .processInstanceId(instance.getId())
            .includeTaskLocalVariables()
            .singleResult();
        assertThat(task).isNotNull();
        assertThat(task.getTaskLocalVariables()
            .get(DshTaskListener.TASK_VARIABLE_ASSIGNMENT_ORG_UNIT)).isEqualTo(DEPT_A);
    }

    @Test
    void globalAssignmentWritesNoAssignmentOrgUnit() {
        // 决策13:global 场景无部门归属,不写局部变量(升级时走映射表回退)
        deployProcess("dsh_global_org_process", """
            <dsh:assignmentRule candidateRoleId="role-any" orgScope="global"/>""");
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
            "dsh_global_org_process", startVars(DEPT_A, XIAOWANG));
        List<Task> tasks = taskService.createTaskQuery().processInstanceId(instance.getId())
            .includeTaskLocalVariables()
            .list();
        assertThat(tasks).extracting(Task::getAssignee)
            .containsExactlyInAnyOrder(ZHANGSAN, LAOZHOU);
        for (Task task : tasks) {
            assertThat(task.getTaskLocalVariables())
                .doesNotContainKey(DshTaskListener.TASK_VARIABLE_ASSIGNMENT_ORG_UNIT);
        }
    }

    private void deployProcess(String key, String assignmentRuleXml) {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.ai/bpmn">
              <process id="%s" name="组织路由测试" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="审批">
                  <extensionElements>
                    %s
                  </extensionElements>
                  <multiInstanceLoopCharacteristics isSequential="false"/>
                </userTask>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""".formatted(key, assignmentRuleXml);
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString(key + ".bpmn20.xml", xml)
            .deploy();
        assertThat(deployment).isNotNull();
    }

    private static Map<String, Object> startVars(String orgUnitId, String applicantUserId) {
        Map<String, Object> vars = new HashMap<>();
        vars.put(DshMultiInstanceSetupListener.PROCESS_VARIABLE_APPLICANT_ORG_UNIT_ID, orgUnitId);
        vars.put(DshSodFilter.PROCESS_VARIABLE_APPLICANT_USER_ID, applicantUserId);
        return vars;
    }
}
