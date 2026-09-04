package com.dsh.flowable.listener;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.flowable.common.engine.api.FlowableException;
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
 * 部署回归测试:复现「web-console 发布带 dsh 多实例 userTask 的流程被
 * flowable-multi-instance-missing-collection 校验拒绝」的线上场景。
 *
 * <p>用 Standalone 内存引擎按 {@link com.dsh.flowable.config.FlowableConfig} 相同方式
 * 注册 DshBpmnParseHandler(pre)与 DshProcessValidator,验证:
 * <ol>
 *   <li>设计侧不写 collection 的 dsh 多实例流程可部署,运行时按
 *       dsh_candidates_&lt;taskId&gt; 变量拆分、assignee 逐人指派、single 策略完成即收口;</li>
 *   <li>无 candidateRoleId 的多实例任务缺 collection 仍报校验错误(不误放行);</li>
 *   <li>带 timeoutPolicy 的任务部署成功并合成 timer job。</li>
 * </ol>
 */
class DshBpmnDeploymentTest {

    private ProcessEngine processEngine;
    private RuntimeService runtimeService;
    private TaskService taskService;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-flowable-test;DB_CLOSE_DELAY=-1");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);

        configuration.setPreBpmnParseHandlers(new java.util.ArrayList<>(List.<BpmnParseHandler>of(new DshBpmnParseHandler())));
        configuration.setProcessValidator(
            new DshProcessValidator(new ProcessValidatorFactory().createDefaultProcessValidator()));

        Map<Object, Object> beans = new HashMap<>();
        beans.put("dshTaskListener", (org.flowable.engine.delegate.TaskListener) task -> { });
        beans.put("dshMultiInstanceSetupListener", (org.flowable.engine.delegate.ExecutionListener) execution ->
            execution.setVariable(DshMultiInstanceSetupListener.CANDIDATES_VARIABLE_PREFIX + execution.getCurrentActivityId(),
                List.of("user-1", "user-2")));
        configuration.setBeans(beans);

        processEngine = configuration.buildProcessEngine();
        runtimeService = processEngine.getRuntimeService();
        taskService = processEngine.getTaskService();
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void deploysAndRunsEngineProvidedCollectionMultiInstance() {
        String xml = bpmn("""
            <process id="dsh_test_process" name="测试流程" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批">
                <extensionElements>
                  <dsh:assignmentRule candidateRoleId="role-1"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false">
                  <completionCondition>${nrOfCompletedInstances >= 1}</completionCondition>
                </multiInstanceLoopCharacteristics>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_test_process.bpmn20.xml", xml)
            .deploy();
        assertThat(deployment).isNotNull();

        ProcessInstance instance = runtimeService.startProcessInstanceByKey("dsh_test_process");
        List<Task> tasks = taskService.createTaskQuery()
            .processInstanceId(instance.getId())
            .taskDefinitionKey("approve")
            .list();
        assertThat(tasks).extracting(Task::getAssignee).containsExactlyInAnyOrder("user-1", "user-2");

        // single 策略:任一人提交即收口,剩余实例待办被引擎删除
        taskService.complete(tasks.get(0).getId());
        assertThat(taskService.createTaskQuery().processInstanceId(instance.getId()).count()).isZero();
        assertThat(runtimeService.createProcessInstanceQuery().processInstanceId(instance.getId()).count()).isZero();
    }

    @Test
    void runsWhenDesignerHandWritesFlowableCollectionAttribute() {
        // 设计师手写 flowable:collection/elementVariable/assignee(BPMN 教程 12.5 示例写法):
        // 引擎不覆盖派发配置,但 start listener 仍按 candidateRoleId 注入候选人变量
        String xml = bpmn("""
            <process id="dsh_manual_process" name="手写流程" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批" flowable:assignee="${dshCandidateUserId}">
                <extensionElements>
                  <dsh:assignmentRule candidateRoleId="role-1"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false"
                    flowable:collection="${dsh_candidates_approve}"
                    flowable:elementVariable="dshCandidateUserId">
                  <completionCondition>${nrOfCompletedInstances &gt;= 1}</completionCondition>
                </multiInstanceLoopCharacteristics>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        processEngine.getRepositoryService().createDeployment()
            .addString("dsh_manual_process.bpmn20.xml", xml)
            .deploy();

        ProcessInstance instance = runtimeService.startProcessInstanceByKey("dsh_manual_process");
        List<Task> tasks = taskService.createTaskQuery()
            .processInstanceId(instance.getId())
            .taskDefinitionKey("approve")
            .list();
        assertThat(tasks).extracting(Task::getAssignee).containsExactlyInAnyOrder("user-1", "user-2");
    }

    @Test
    void stillRejectsMultiInstanceWithoutCollectionWhenDshRuleAbsent() {
        String xml = bpmn("""
            <process id="dsh_bad_process" name="坏流程" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="task1"/>
              <userTask id="task1" name="无人认领">
                <multiInstanceLoopCharacteristics isSequential="false"/>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="task1" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        assertThatThrownBy(() -> processEngine.getRepositoryService().createDeployment()
            .addString("dsh_bad_process.bpmn20.xml", xml)
            .deploy())
            .isInstanceOf(FlowableException.class)
            .hasMessageContaining("flowable-multi-instance-missing-collection");
    }

    @Test
    void deploysTimeoutEscalationTaskWithTimerJob() {
        String xml = bpmn("""
            <process id="dsh_timeout_process" name="超时流程" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批">
                <extensionElements>
                  <dsh:assignmentRule candidateRoleId="role-1"/>
                  <dsh:actionPolicy>
                    <dsh:timeoutPolicy duration="PT24H" escalateToRoleId="role-2"/>
                  </dsh:actionPolicy>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false">
                  <completionCondition>${nrOfCompletedInstances >= 1}</completionCondition>
                </multiInstanceLoopCharacteristics>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        processEngine.getRepositoryService().createDeployment()
            .addString("dsh_timeout_process.bpmn20.xml", xml)
            .deploy();

        ProcessInstance instance = runtimeService.startProcessInstanceByKey("dsh_timeout_process");
        assertThat(taskService.createTaskQuery().processInstanceId(instance.getId()).count()).isEqualTo(2);
        // 合成的 boundary timer 被解析并创建 timer job(async executor 关闭,job 只创建不执行)
        assertThat(processEngine.getManagementService().createTimerJobQuery()
            .processInstanceId(instance.getId()).count()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void keepsUserPromptWithJsonQuotesIntactAfterDeploy() {
        // 复现线上:prompt 里的 JSON 骨架含引号,曾以元素正文存储被引擎 StAX
        // (IS_REPLACING_ENTITY_REFERENCES=false)切成多个 CHARACTER 事件,
        // Flowable 的 setElementText 只保留最后一段,dsh_node_meta 里只剩
        // 「} 之后不要使出任何其他内容」;改 text 属性存储后必须完整往返。
        String prompt = "流程变量1：{{流程变量1}}\n流程变量2：{{流程变量2}}\n\n"
            + "请无脑输出干净JSON格式:\n{\n  \"a\": \"\",\n  \"b\": \"\"\n}\n"
            + "除此之外不要使出任何其他内容";
        // XML 属性值转义:换行必须用字符引用 &#10;(字面换行会被属性规范化成空格),
        // 引号转义为 &quot;,与 moddle escapeAttr 的输出一致。
        String attrValue = prompt
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace("\"", "&quot;")
            .replace("\n", "&#10;");
        String xml = bpmn("""
            <process id="dsh_prompt_process" name="指令流程" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
              <userTask id="approve" name="审批">
                <extensionElements>
                  <dsh:userPrompt text="%s"/>
                </extensionElements>
              </userTask>
              <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
              <endEvent id="end"/>
            </process>""".formatted(attrValue));

        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_prompt_process.bpmn20.xml", xml)
            .deploy();
        String procdefId = processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId()).singleResult().getId();

        // 走生产同一路径:resolver 查 BpmnModel(经 StAX 解析)后读 dsh 元数据
        DshExtensionResolver resolver = new DshExtensionResolver(
            processEngine.getRepositoryService(),
            new DshBpmnExtensionParser(),
            new DshExtensionPropertiesCache());
        DshExtensionProperties props = resolver.resolveTaskProperties(procdefId, "approve");
        assertThat(props).isNotNull();
        assertThat(props.userPrompt()).isEqualTo(prompt);
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
