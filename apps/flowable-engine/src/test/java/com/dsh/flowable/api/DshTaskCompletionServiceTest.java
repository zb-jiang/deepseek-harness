package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshExtensionPropertiesCache;
import com.dsh.flowable.listener.DshExtensionResolver;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * userTask 提交端点的系统注入变量守卫:source=system 声明(启动时按登录人注入的
 * initiator)拒绝任务提交覆盖;普通声明变量提交不受影响。
 *
 * <p>用 Standalone 内存引擎(H2)直接构造服务(不经 Spring 上下文);
 * H2 库名不带 DB_CLOSE_DELAY,每个测试方法独立库。
 */
class DshTaskCompletionServiceTest {

    private ProcessEngine processEngine;
    private DshTaskCompletionService completionService;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-task-completion-test");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        processEngine = configuration.buildProcessEngine();
        DshExtensionResolver resolver = new DshExtensionResolver(
            processEngine.getRepositoryService(),
            new DshBpmnExtensionParser(),
            new DshExtensionPropertiesCache());
        completionService = new DshTaskCompletionService(processEngine.getTaskService(), resolver);
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void submittingSystemVariableIsRejected() {
        Task task = startProcessWithTask();

        assertThatThrownBy(() -> completionService.completeWithVariables(
            task, java.util.Map.of("initiator", java.util.Map.of("userId", "forged"))))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("系统注入变量")
            .hasMessageContaining("不允许任务提交覆盖");

        // 任务仍在(提交被拒,未完成)
        assertThat(processEngine.getTaskService().createTaskQuery()
            .taskId(task.getId()).count()).isEqualTo(1);
    }

    @Test
    void submittingDeclaredVariableCompletes() {
        Task task = startProcessWithTask();

        completionService.completeWithVariables(task, java.util.Map.of("amount", "300"));

        // 提交成功,实例携带变量结束
        assertThat(processEngine.getTaskService().createTaskQuery()
            .taskId(task.getId()).count()).isZero();
        ProcessInstance instance = processEngine.getRuntimeService()
            .createProcessInstanceQuery()
            .processInstanceId(task.getProcessInstanceId())
            .singleResult();
        assertThat(instance).isNull();
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(task.getProcessInstanceId())
            .variableName("amount")
            .singleResult()
            .getValue()).isEqualTo("300");
    }

    private Task startProcessWithTask() {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="dsh_task_completion_process" isExecutable="true">
                <extensionElements>
                  <dsh:contextVariables>
                    <dsh:contextVariable name="initiator" type="object" source="system">
                      <dsh:field name="userId" type="string"/>
                      <dsh:field name="name" type="string"/>
                      <dsh:field name="email" type="string"/>
                    </dsh:contextVariable>
                    <dsh:contextVariable name="amount" type="string" source="start-param"/>
                  </dsh:contextVariables>
                </extensionElements>
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
                <userTask id="task" name="提交" flowable:assignee="user-1"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""";
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_task_completion_process.bpmn20.xml", xml)
            .deploy();
        String procdefId = processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId())
            .singleResult()
            .getId();
        processEngine.getRuntimeService().startProcessInstanceById(procdefId);
        return processEngine.getTaskService().createTaskQuery()
            .taskAssignee("user-1")
            .singleResult();
    }
}
