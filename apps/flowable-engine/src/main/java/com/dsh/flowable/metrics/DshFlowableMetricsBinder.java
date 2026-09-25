package com.dsh.flowable.metrics;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.binder.MeterBinder;
import org.flowable.engine.ManagementService;
import org.springframework.stereotype.Component;

/**
 * Flowable 引擎运行时健康指标 Binder(分析看板「运维健康」tab 的数据源)。
 *
 * <p>注册 4 个 Gauge 覆盖 async executor 的四类 job 积压(Micrometer 读取时惰性求值,
 * 无需自己轮询;每次 Prometheus/actuator 采样才执行 count 查询):
 * <ul>
 *   <li>{@code dsh.flowable.jobs.async}:等待执行的 async job 数(DSH backend task 走此通道);</li>
 *   <li>{@code dsh.flowable.jobs.timer}:等待触发的 timer job 数(超时升级边界事件等);</li>
 *   <li>{@code dsh.flowable.jobs.deadletter}:dead letter job 数(重试耗尽的失败 job,
 *       需要人工介入——分析看板的阈值告警重点盯防);</li>
 *   <li>{@code dsh.flowable.jobs.suspended}:挂起 job 数(所属流程定义/实例被挂起)。</li>
 * </ul>
 *
 * <p>指标名用点分(Micrometer 命名约定),web-console 轮询方按同名白名单采集。
 * 只读查询,不影响引擎运行。
 */
@Component
public class DshFlowableMetricsBinder implements MeterBinder {

    private final ManagementService managementService;

    public DshFlowableMetricsBinder(ManagementService managementService) {
        this.managementService = managementService;
    }

    @Override
    public void bindTo(MeterRegistry registry) {
        Gauge.builder("dsh.flowable.jobs.async", managementService,
                ms -> ms.createJobQuery().count())
            .description("Async jobs waiting to execute (DSH backend task channel)")
            .register(registry);
        Gauge.builder("dsh.flowable.jobs.timer", managementService,
                ms -> ms.createTimerJobQuery().count())
            .description("Timer jobs waiting to fire (timeout escalation boundary events etc.)")
            .register(registry);
        Gauge.builder("dsh.flowable.jobs.deadletter", managementService,
                ms -> ms.createDeadLetterJobQuery().count())
            .description("Dead letter jobs (retries exhausted, manual intervention required)")
            .register(registry);
        Gauge.builder("dsh.flowable.jobs.suspended", managementService,
                ms -> ms.createSuspendedJobQuery().count())
            .description("Suspended jobs (owning definition/instance suspended)")
            .register(registry);
    }
}
