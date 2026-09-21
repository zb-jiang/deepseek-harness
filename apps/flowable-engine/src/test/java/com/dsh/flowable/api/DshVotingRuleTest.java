package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshBpmnParseHandler;
import com.dsh.flowable.listener.DshCandidateResolver;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshExtensionPropertiesCache;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.dsh.flowable.listener.DshMultiInstanceSetupListener;
import com.dsh.flowable.listener.DshProcessValidator;
import com.dsh.flowable.listener.DshSodFilter;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.MultiInstanceLoopCharacteristics;
import org.flowable.bpmn.model.UserTask;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.TaskService;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.parse.BpmnParseHandler;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.flowable.validation.ProcessValidatorFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 会签计票端到端测试(design 2026-09-15):votingRule 解析 → parse 时自动生成
 * 完成条件 → 提交端点逐份聚合票数 → 达到通过/否决票数提前收(剩余待办自动删除)。
 *
 * <p>用 Standalone 内存引擎按生产同路径注册 DshBpmnParseHandler(pre)与
 * DshProcessValidator;候选人由 test bean 注入 3 人(user-1/2/3),
 * 提交走 {@link DshTaskCompletionService#completeWithVariables}。
 */
class DshVotingRuleTest {

    private ProcessEngine processEngine;
    private TaskService taskService;
    private DshTaskCompletionService completionService;

    /** 真实 repositoryService 引擎 build 后回填(listener 经 Proxy 延迟引用)。 */
    private final java.util.concurrent.atomic.AtomicReference<org.flowable.engine.RepositoryService>
        realRepositoryService = new java.util.concurrent.atomic.AtomicReference<>();

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-voting-test");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        configuration.setPreBpmnParseHandlers(
            new java.util.ArrayList<>(List.<BpmnParseHandler>of(new DshBpmnParseHandler())));
        configuration.setProcessValidator(
            new DshProcessValidator(new ProcessValidatorFactory().createDefaultProcessValidator()));

        // listener 需在 build 前注册为 bean,其依赖的 repositoryService 只能经 Proxy 延迟
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
        com.dsh.flowable.repository.DshMembershipRepository membershipRepository =
            new com.dsh.flowable.repository.DshMembershipRepository(null) {
                @Override
                public List<String> findActiveUserIdsByRoleId(String roleId) {
                    return List.of("user-1", "user-2", "user-3");
                }
            };
        DshMultiInstanceSetupListener setupListener = new DshMultiInstanceSetupListener(
            resolver,
            membershipRepository,
            new DshSodFilter(null) {
                @Override
                public List<String> filter(List<String> candidates,
                                           List<DshExtensionProperties.SodRule> sodRules,
                                           String processInstanceId,
                                           String currentTaskDefKey,
                                           String applicantUserId) {
                    return candidates;
                }
            },
            new DshCandidateResolver(new com.dsh.flowable.repository.DshOrgUnitRepository(null), membershipRepository));

        Map<Object, Object> beans = new HashMap<>();
        beans.put("dshTaskListener", (org.flowable.engine.delegate.TaskListener) task -> { });
        beans.put("dshMultiInstanceSetupListener", setupListener);
        configuration.setBeans(beans);

        processEngine = configuration.buildProcessEngine();
        taskService = processEngine.getTaskService();
        realRepositoryService.set(processEngine.getRepositoryService());
        completionService = new DshTaskCompletionService(taskService, resolver);
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void twoPassVotesCompleteEarlyAndDeleteRemaining() {
        ProcessInstance instance = deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="2" rejectCount="2"/>
            """);

        List<Task> tasks = approveTasks(instance.getId());
        assertThat(tasks).hasSize(3);

        completionService.completeWithVariables(tasks.get(0), Map.of("approved", true));
        completionService.completeWithVariables(tasks.get(1), Map.of("approved", true));

        // 达到 2 票同意:多实例提前收,剩余待办自动删除,流程结束
        assertThat(taskService.createTaskQuery().processInstanceId(instance.getId()).count()).isZero();
        assertThat(processEngine.getRuntimeService().createProcessInstanceQuery()
            .processInstanceId(instance.getId()).count()).isZero();
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName("dsh_passCount_approve")
            .singleResult()
            .getValue()).isEqualTo(2L);
    }

    @Test
    void twoRejectVotesCompleteEarly() {
        ProcessInstance instance = deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="2" rejectCount="2"/>
            """);

        List<Task> tasks = approveTasks(instance.getId());
        completionService.completeWithVariables(tasks.get(0), Map.of("approved", false));
        completionService.completeWithVariables(tasks.get(1), Map.of("approved", false));

        // 达到 2 票否决:提前收
        assertThat(taskService.createTaskQuery().processInstanceId(instance.getId()).count()).isZero();
        assertThat(processEngine.getRuntimeService().createProcessInstanceQuery()
            .processInstanceId(instance.getId()).count()).isZero();
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName("dsh_rejectCount_approve")
            .singleResult()
            .getValue()).isEqualTo(2L);
    }

    @Test
    void mixedVotesBelowThresholdsWaitForRemainingVoters() {
        ProcessInstance instance = deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="2" rejectCount="2"/>
            """);

        List<Task> tasks = approveTasks(instance.getId());
        completionService.completeWithVariables(tasks.get(0), Map.of("approved", true));
        completionService.completeWithVariables(tasks.get(1), Map.of("approved", false));

        // 1 同意 1 否决:未达阈值,第 3 人待办保留
        assertThat(taskService.createTaskQuery()
            .processInstanceId(instance.getId()).count()).isEqualTo(1);
        assertThat(processEngine.getRuntimeService().getVariable(
            instance.getId(), "dsh_passCount_approve")).isEqualTo(1L);
        assertThat(processEngine.getRuntimeService().getVariable(
            instance.getId(), "dsh_rejectCount_approve")).isEqualTo(1L);
    }

    @Test
    void missingVoteValueDoesNotCountButCompletes() {
        ProcessInstance instance = deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="3"/>
            """);

        List<Task> tasks = approveTasks(instance.getId());
        // 提交不含 approved(员工清空映射):实例完成但不计票
        completionService.completeWithVariables(tasks.get(0), Map.of("comment", "弃权"));

        assertThat(taskService.createTaskQuery()
            .processInstanceId(instance.getId()).count()).isEqualTo(2);
        // 计票变量仍为初始 0(初始化由 start listener 完成,本次提交未计票)
        assertThat(processEngine.getRuntimeService().getVariable(
            instance.getId(), "dsh_passCount_approve")).isEqualTo(0L);
        assertThat(processEngine.getRuntimeService().getVariable(
            instance.getId(), "dsh_rejectCount_approve")).isEqualTo(0L);
    }

    @Test
    void manualCompletionConditionIsNotOverwritten() {
        // 手写完成条件的 votingRule 节点:parse handler 不覆盖(纵深防御,
        // 矛盾配置由 web-console 发布校验拒绝)
        deploy("""
            <process id="dsh_voting_manual" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批">
                <extensionElements>
                  <dsh:assignmentRule candidateRoleId="role-1"/>
                  <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false">
                  <completionCondition>${nrOfCompletedInstances &gt;= 3}</completionCondition>
                </multiInstanceLoopCharacteristics>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");
        assertThat(loopCharacteristics("dsh_voting_manual").getCompletionCondition())
            .isEqualTo("${nrOfCompletedInstances >= 3}");
    }

    @Test
    void noRejectCountGeneratesPassOnlyCondition() {
        deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
            """);
        assertThat(loopCharacteristics("dsh_voting_test").getCompletionCondition())
            .isEqualTo("${dsh_passCount_approve >= 2}");
    }

    @Test
    void rejectCountGeneratesPassOrRejectCondition() {
        deployAndStart("""
            <dsh:votingRule variable="approved" passValue="true" passCount="3" rejectCount="2"/>
            """);
        assertThat(loopCharacteristics("dsh_voting_test").getCompletionCondition())
            .isEqualTo("${dsh_passCount_approve >= 3 || dsh_rejectCount_approve >= 2}");
    }

    /** 部署带 votingRule 的 3 人会签流程并启动实例。 */
    private ProcessInstance deployAndStart(String votingRuleXml) {
        deploy("""
            <process id="dsh_voting_test" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="approved" type="boolean"/>
                  <dsh:contextVariable name="comment" type="string"/>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批">
                <extensionElements>
                  <dsh:assignmentRule candidateRoleId="role-1"/>
            %s
                  <dsh:outputMappings>
                    <dsh:mapping source="approved" target="approved"/>
                  </dsh:outputMappings>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false"/>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""".formatted(votingRuleXml));
        return processEngine.getRuntimeService().startProcessInstanceByKey("dsh_voting_test");
    }

    /** 部署指定 process 正文的 BPMN(默认命名空间声明见 bpmn())。 */
    private void deploy(String processBody) {
        processEngine.getRepositoryService().createDeployment()
            .addString("voting-process.bpmn20.xml", bpmn(processBody))
            .deploy();
    }

    private List<Task> approveTasks(String processInstanceId) {
        return taskService.createTaskQuery()
            .processInstanceId(processInstanceId)
            .taskDefinitionKey("approve")
            .list();
    }

    /** 按流程 key 取已部署模型的 approve 节点多实例配置。 */
    private MultiInstanceLoopCharacteristics loopCharacteristics(String processDefinitionKey) {
        String procdefId = processEngine.getRepositoryService().createProcessDefinitionQuery()
            .processDefinitionKey(processDefinitionKey).latestVersion().singleResult().getId();
        UserTask userTask = new DshExtensionResolver(
            processEngine.getRepositoryService(),
            new DshBpmnExtensionParser(),
            new DshExtensionPropertiesCache()).findUserTask(procdefId, "approve");
        assertThat(userTask).isNotNull();
        return userTask.getLoopCharacteristics();
    }

    private static String bpmn(String processBody) {
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.ai/bpmn">
            %s
            </definitions>""".formatted(processBody);
    }
}
