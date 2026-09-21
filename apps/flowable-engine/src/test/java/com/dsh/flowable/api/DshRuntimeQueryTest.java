package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.runtime.ProcessInstance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 运行中实例查询回归测试:验证 Web Console 实例列表依赖的
 * {@link DshRuntimeController} 查询语义。
 *
 * <p>用 Standalone 内存引擎(H2,HistoryLevel.FULL)直接构造 controller(不经 Spring 上下文),
 * 覆盖:按 processDefinitionKey 跨部署版本收集运行中实例(重新发布后旧版本实例不漏)、
 * DTO 带定义 key/名称/版本(官方 runtime REST representation 不带,归属反查依赖)。
 */
class DshRuntimeQueryTest {

    private ProcessEngine processEngine;
    private DshRuntimeController controller;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        // 每个测试方法独立库名:DB_CLOSE_DELAY=-1 会让 H2 库在引擎 close 后残留,
        // 同名库会把上一方法的运行实例泄漏给下一方法(空断言被残留数据击穿)
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-runtime-test-" + System.nanoTime()
            + ";DB_CLOSE_DELAY=-1");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        processEngine = configuration.buildProcessEngine();
        controller = new DshRuntimeController(processEngine.getRuntimeService());
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void collectsRunningInstancesByProcessDefinitionKeyAcrossVersions() {
        String procdefV1 = deployApprovalProcess();
        RuntimeService runtimeService = processEngine.getRuntimeService();
        ProcessInstance older = runtimeService.startProcessInstanceById(procdefV1);

        // 同 key 重新部署产生 version 2,新实例挂在 v2 上
        String procdefV2 = deployApprovalProcess();
        ProcessDefinition definitionV2 = processEngine.getRepositoryService()
            .createProcessDefinitionQuery().processDefinitionId(procdefV2).singleResult();
        ProcessInstance newer = runtimeService.startProcessInstanceById(procdefV2);

        // 按 key 查:跨版本收集,旧版本上的运行实例不漏
        List<RuntimeProcessInstanceDto> byKey = controller.getRuntimeProcessInstances(
            "dsh_runtime_process", 0, 50);
        assertThat(byKey).extracting(RuntimeProcessInstanceDto::id)
            .containsExactlyInAnyOrder(older.getId(), newer.getId());

        // DTO 带定义 key/名称/版本(runtime ProcessInstance 接口自带)
        RuntimeProcessInstanceDto v1Instance = byKey.stream()
            .filter(dto -> dto.id().equals(older.getId())).findFirst().orElseThrow();
        assertThat(v1Instance.processDefinitionKey()).isEqualTo("dsh_runtime_process");
        assertThat(v1Instance.processDefinitionName()).isEqualTo("运行查询测试流程");
        assertThat(v1Instance.processDefinitionVersion()).isEqualTo(1);
        assertThat(v1Instance.processDefinitionId()).isEqualTo(procdefV1);
        assertThat(v1Instance.suspended()).isFalse();

        RuntimeProcessInstanceDto v2Instance = byKey.stream()
            .filter(dto -> dto.id().equals(newer.getId())).findFirst().orElseThrow();
        assertThat(v2Instance.processDefinitionVersion())
            .isEqualTo(definitionV2.getVersion());

        // 全量查询(不传 key)也能命中
        assertThat(controller.getRuntimeProcessInstances(null, 0, 50))
            .extracting(RuntimeProcessInstanceDto::id)
            .containsExactlyInAnyOrder(older.getId(), newer.getId());
    }

    @Test
    void keyFilterExcludesOtherDefinitionsAndTerminatedInstances() {
        String procdefId = deployApprovalProcess();
        RuntimeService runtimeService = processEngine.getRuntimeService();
        ProcessInstance instance = runtimeService.startProcessInstanceById(
            procdefId, "biz-terminate", java.util.Map.of());
        runtimeService.deleteProcessInstance(instance.getId(), "管理员强制终止");

        // 已终止实例不在 runtime 查询范围;key 不匹配时返回空
        assertThat(controller.getRuntimeProcessInstances("dsh_runtime_process", 0, 50)).isEmpty();
        assertThat(controller.getRuntimeProcessInstances("other_key", 0, 50)).isEmpty();
    }

    /** 部署一个最小审批流程并返回 procdefId(每次调用产生新版本)。 */
    private String deployApprovalProcess() {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="dsh_runtime_process" name="运行查询测试流程" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="审批" flowable:assignee="user-1"/>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""";
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_runtime_process.bpmn20.xml", xml)
            .deploy();
        return processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId())
            .singleResult()
            .getId();
    }
}
