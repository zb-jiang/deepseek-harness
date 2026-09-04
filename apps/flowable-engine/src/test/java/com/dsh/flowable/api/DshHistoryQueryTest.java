package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.HistoryService;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * 历史查询回归测试:验证 Web Console「历史实例 + 历史变量 + 活动路径」依赖的
 * {@link DshHistoryController} 查询语义。
 *
 * <p>用 Standalone 内存引擎(H2,HistoryLevel.FULL,与
 * {@link com.dsh.flowable.config.FlowableConfig} 一致)直接构造 controller(不经 Spring 上下文),
 * 覆盖:
 * <ol>
 *   <li>历史实例:processInstanceId/processDefinitionId 精确过滤、finished 状态过滤,
 *       已结束实例的 endTime/deleteReason 语义;</li>
 *   <li>历史变量:实例上下文变量的最终值(标量/JSON 字符串),缺 processInstanceId 报 400;</li>
 *   <li>历史活动:start → userTask → end 的执行顺序回溯;</li>
 *   <li>历史任务:带 processInstanceId 时返回实例全部任务(不按当前用户过滤),
 *       已结束任务带 endTime。</li>
 * </ol>
 */
class DshHistoryQueryTest {

    private ProcessEngine processEngine;
    private DshHistoryController controller;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-history-test;DB_CLOSE_DELAY=-1");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        processEngine = configuration.buildProcessEngine();
        HistoryService historyService = processEngine.getHistoryService();
        controller = new DshHistoryController(
            historyService,
            processEngine.getRepositoryService(),
            objectMapper);
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void queriesFinishedInstanceWithVariablesActivitiesAndTasks() {
        String procdefId = deployApprovalProcess();
        RuntimeService runtimeService = processEngine.getRuntimeService();
        TaskService taskService = processEngine.getTaskService();

        ProcessInstance instance = runtimeService.startProcessInstanceById(
            procdefId,
            "biz-001",
            Map.of(
                "amount", 5000L,
                "comment", "报销",
                "payload", "{\"items\":2}"));

        // 审批人完成任务 → 实例结束
        Task task = taskService.createTaskQuery()
            .processInstanceId(instance.getId())
            .taskDefinitionKey("approve")
            .singleResult();
        taskService.complete(task.getId());

        // 历史实例:processInstanceId 精确过滤,已结束语义
        List<HistoricProcessInstanceDto> byId = controller.getHistoricProcessInstances(
            instance.getId(), null, null, null, null, 0, 50);
        assertThat(byId).hasSize(1);
        HistoricProcessInstanceDto historic = byId.get(0);
        assertThat(historic.businessKey()).isEqualTo("biz-001");
        assertThat(historic.endTime()).isNotNull();
        assertThat(historic.deleteReason()).isNull();
        assertThat(historic.processDefinitionId()).isEqualTo(procdefId);

        // processDefinitionId 过滤命中,finished=true 只含已结束
        List<HistoricProcessInstanceDto> byDef = controller.getHistoricProcessInstances(
            null, procdefId, null, Boolean.TRUE, null, 0, 50);
        assertThat(byDef).extracting(HistoricProcessInstanceDto::id).containsExactly(instance.getId());
        assertThat(controller.getHistoricProcessInstances(
            null, procdefId, null, Boolean.FALSE, null, 0, 50)).isEmpty();

        // 历史变量:最终值完整,JSON 字符串保持文本
        List<HistoricVariableDto> variables = controller.getHistoricVariables(instance.getId());
        Map<String, HistoricVariableDto> varByName = new java.util.HashMap<>();
        for (HistoricVariableDto v : variables) {
            varByName.put(v.variableName(), v);
        }
        assertThat(varByName.get("amount").value().asLong()).isEqualTo(5000L);
        assertThat(varByName.get("comment").value().asText()).isEqualTo("报销");
        assertThat(varByName.get("payload").value().asText()).isEqualTo("{\"items\":2}");
        assertThat(varByName.get("amount").lastUpdatedTime()).isNotNull();

        // 历史活动:回溯执行路径覆盖 start/approve/end(同毫秒活动顺序不稳定,不按下标断言)
        List<HistoricActivityDto> activities = controller.getHistoricActivities(instance.getId());
        assertThat(activities).isNotEmpty();
        List<String> nodeTypes = activities.stream()
            .filter(a -> !"sequenceFlow".equals(a.activityType()))
            .map(HistoricActivityDto::activityType)
            .toList();
        assertThat(nodeTypes).containsExactlyInAnyOrder("startEvent", "userTask", "endEvent");
        assertThat(activities).allSatisfy(a -> {
            assertThat(a.endTime()).isNotNull();
            assertThat(a.durationInMillis()).isNotNull();
        });

        // 历史任务:带 processInstanceId 时返回全部任务(不按用户过滤),已结束带 endTime
        List<HistoricTaskDto> tasks = controller.getHistoricTasks(
            instance.getId(), null, null, 0, 50, null);
        assertThat(tasks).hasSize(1);
        assertThat(tasks.get(0).assignee()).isEqualTo("user-1");
        assertThat(tasks.get(0).endTime()).isNotNull();
        assertThat(tasks.get(0).taskDefinitionKey()).isEqualTo("approve");
    }

    @Test
    void runningInstanceAppearsInHistoricQueryWithUnfinishedFilter() {
        String procdefId = deployApprovalProcess();
        ProcessInstance instance = processEngine.getRuntimeService()
            .startProcessInstanceById(procdefId);

        // 运行中实例也写入 ACT_HI_PROCINST:unfinished 过滤可见,endTime 为 null
        List<HistoricProcessInstanceDto> running = controller.getHistoricProcessInstances(
            null, procdefId, null, Boolean.FALSE, null, 0, 50);
        assertThat(running).extracting(HistoricProcessInstanceDto::id)
            .containsExactly(instance.getId());
        assertThat(running.get(0).endTime()).isNull();

        // 运行中实例的历史变量返回当前值(本例未注入变量,应为空)
        List<HistoricVariableDto> variables = controller.getHistoricVariables(instance.getId());
        assertThat(variables).isEmpty();
        List<HistoricActivityDto> activities = controller.getHistoricActivities(instance.getId());
        assertThat(activities).isNotEmpty();
        // 当前唯一进行中的活动是审批节点(endTime 为 null);同毫秒启动的活动顺序不稳定,不按下标断言
        List<HistoricActivityDto> ongoing = activities.stream()
            .filter(a -> a.endTime() == null)
            .toList();
        assertThat(ongoing).hasSize(1);
        assertThat(ongoing.get(0).activityId()).isEqualTo("approve");
    }

    @Test
    void missingInstanceIdRejectedForVariablesAndActivities() {
        assertThatThrownBy(() -> controller.getHistoricVariables(null))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(e -> ((ResponseStatusException) e).getStatusCode().value())
            .isEqualTo(400);
        assertThatThrownBy(() -> controller.getHistoricVariables(" "))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> controller.getHistoricActivities(null))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(e -> ((ResponseStatusException) e).getStatusCode().value())
            .isEqualTo(400);
    }

    /** 部署一个最小审批流程并返回 procdefId。 */
    private String deployApprovalProcess() {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="dsh_history_process" name="历史查询测试流程" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="审批" flowable:assignee="user-1"/>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""";
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_history_process.bpmn20.xml", xml)
            .deploy();
        return processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId())
            .singleResult()
            .getId();
    }
}
