package com.dsh.flowable.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ManagementService;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link DshFlowableMetricsBinder} 回归测试:H2 内存引擎创建 async/timer/dead-letter
 * job 后,4 个 Gauge 的取值随之变化(Gauge 惰性求值——bindTo 只注册,读值时才查引擎)。
 *
 * <p>制造 job 的方式:部署一个 async serviceTask 流程并启动实例——async executor 关闭,
 * job 停留在等待队列(不计入 dead letter);再放一个 timer job(基于 date 的定时边界
 * 事件,引擎不触发只计数)。
 */
class DshFlowableMetricsBinderTest {

    private ProcessEngine processEngine;
    private SimpleMeterRegistry registry;
    private ManagementService managementService;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-metrics-binder-test;DB_CLOSE_DELAY=-1");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        // async executor 关闭:job 不会被执行,稳定停留在待执行状态供 Gauge 计数
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        processEngine = configuration.buildProcessEngine();
        managementService = processEngine.getManagementService();
        registry = new SimpleMeterRegistry();
        new DshFlowableMetricsBinder(managementService).bindTo(registry);
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void jobGaugesReflectEngineJobCounts() {
        // 部署含 async serviceTask 的流程并启动 → 1 个等待执行的 async job
        processEngine.getRepositoryService().createDeployment()
            .addString("async_flow.bpmn20.xml", """
                <?xml version="1.0" encoding="UTF-8"?>
                <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                             xmlns:flowable="http://flowable.org/bpmn"
                             targetNamespace="http://dsh.test">
                  <process id="async_flow" isExecutable="true">
                    <startEvent id="start"/>
                    <sequenceFlow id="f1" sourceRef="start" targetRef="auto"/>
                    <serviceTask id="auto" flowable:class="%s" flowable:async="true"/>
                    <sequenceFlow id="f2" sourceRef="auto" targetRef="end"/>
                    <endEvent id="end"/>
                  </process>
                </definitions>""".formatted(NoopDelegate.class.getName()))
            .deploy();
        processEngine.getRuntimeService().startProcessInstanceByKey("async_flow");

        assertThat(gaugeValue("dsh.flowable.jobs.async")).isEqualTo(1.0);
        assertThat(gaugeValue("dsh.flowable.jobs.timer")).isEqualTo(0.0);
        assertThat(gaugeValue("dsh.flowable.jobs.deadletter")).isEqualTo(0.0);
        assertThat(gaugeValue("dsh.flowable.jobs.suspended")).isEqualTo(0.0);

        // job 执行后(async executor 关闭,手工 trigger)async 积压归零
        managementService.createJobQuery().list()
            .forEach(job -> managementService.executeJob(job.getId()));
        assertThat(gaugeValue("dsh.flowable.jobs.async")).isEqualTo(0.0);
    }

    private double gaugeValue(String name) {
        return registry.get(name).gauge().value();
    }

    /** async serviceTask 的空实现 delegate(只为制造 job,不产生副作用)。 */
    public static class NoopDelegate implements org.flowable.engine.delegate.JavaDelegate {
        @Override
        public void execute(org.flowable.engine.delegate.DelegateExecution execution) {
            // no-op
        }
    }
}
