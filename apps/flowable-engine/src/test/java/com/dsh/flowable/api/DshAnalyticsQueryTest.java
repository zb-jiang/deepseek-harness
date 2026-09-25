package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.flowable.common.engine.impl.history.HistoryLevel;
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
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 分析聚合查询回归测试:验证分析看板「业务分析」tab 依赖的
 * {@link DshAnalyticsQueryService} SQL 语义(H2 内存引擎,HistoryLevel.FULL,
 * 与生产 PG 共用同一套 SQL——聚合写法均已做双方言兼容)。
 *
 * <p>覆盖设计文档 §6.2 的三个语义边界:
 * <ol>
 *   <li>overview/daily-volumes/activity-stats/task-stats 的基本口径:
 *       completed/terminated 按 DELETE_REASON_ 区分,running 按 END_TIME_ 为空;</li>
 *   <li>进行中节点 DURATION_ 为 NULL 被剔除,不参与时长统计;</li>
 *   <li>多实例(会签)节点按成员份数计数;</li>
 *   <li>processDefinitionKey 过滤跨部署版本聚合(子查询命中全部版本)。</li>
 * </ol>
 *
 * <p>每个测试用独立的 H2 内存库(库名带自增序号)避免历史数据串扰:
 * 聚合是跨实例全表口径,共享库会让无 key 过滤的断言互相污染。
 */
class DshAnalyticsQueryTest {

    private static final AtomicInteger DB_SEQ = new AtomicInteger();

    private ProcessEngine processEngine;
    private DshAnalyticsQueryService queryService;
    private RuntimeService runtimeService;
    private TaskService taskService;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-analytics-test-" + DB_SEQ.incrementAndGet()
            + ";DB_CLOSE_DELAY=-1");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        processEngine = configuration.buildProcessEngine();
        queryService = new DshAnalyticsQueryService(new JdbcTemplate(
            processEngine.getProcessEngineConfiguration().getDataSource()));
        runtimeService = processEngine.getRuntimeService();
        taskService = processEngine.getTaskService();
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void overviewDailyVolumesAndStatsCoverFinishedRunningTerminated() {
        String procdefId = deployApprovalProcess("dsh_ana_base");

        // 正常完成 1 单
        ProcessInstance finished = runtimeService.startProcessInstanceById(procdefId, "biz-ok", Map.of());
        completeTask(finished.getId(), "approve");
        // 运行中 1 单(approve 节点停留,该活动时长为 NULL)
        runtimeService.startProcessInstanceById(procdefId, "biz-running", Map.of());
        // 终止 1 单
        ProcessInstance terminated = runtimeService.startProcessInstanceById(procdefId, "biz-term", Map.of());
        runtimeService.deleteProcessInstance(terminated.getId(), "管理员强制终止");

        // overview:三种状态口径
        AnalyticsOverviewDto overview = queryService.overview(30, null);
        assertThat(overview.started()).isEqualTo(3);
        assertThat(overview.completed()).isEqualTo(1);
        assertThat(overview.running()).isEqualTo(1);
        assertThat(overview.terminated()).isEqualTo(1);
        // 只有正常完成实例贡献时长统计
        assertThat(overview.avgDurationMs()).isNotNull();
        assertThat(overview.p95DurationMs()).isNotNull();

        // daily-volumes:合并到同一日期轴,今日 started=3 / completed=1
        List<DailyVolumeDto> volumes = queryService.dailyVolumes(30, null);
        assertThat(volumes).hasSize(1);
        assertThat(volumes.get(0).started()).isEqualTo(3);
        assertThat(volumes.get(0).completed()).isEqualTo(1);
        assertThat(volumes.get(0).date()).matches("\\d{4}-\\d{2}-\\d{2}");

        // activity-stats:start 节点 3 单都走过(有时长);end 节点只有完成单到达;
        // 运行中实例的 approve 节点(NULL 时长)被剔除,但完成单的 approve 计入
        Map<String, ActivityStatDto> stats = statsByActivityId(queryService.activityStats(30, null));
        assertThat(stats.get("start").count()).isEqualTo(3);
        assertThat(stats.get("end").count()).isEqualTo(1);
        assertThat(stats.get("approve").count()).isGreaterThanOrEqualTo(1);
        assertThat(stats.get("approve").avgDurationMs()).isNotNull();
        // 连线行也参与统计(路径热力数据源)
        assertThat(stats.get("flow1").count()).isEqualTo(3);

        // task-stats:办理人聚合(完成单 assignee=user-1;终止单历史任务无时长不计)
        List<TaskStatDto> taskStats = queryService.taskStats(30, null);
        assertThat(taskStats).extracting(TaskStatDto::assignee).contains("user-1");
    }

    @Test
    void multiInstanceUserTaskCountsPerMember() {
        deployMultiInstanceProcess("dsh_ana_mi");

        ProcessInstance instance = runtimeService.startProcessInstanceByKey("dsh_ana_mi", Map.of());
        // 会签 2 份(同 assignee),全部完成后实例结束
        for (Task task : taskService.createTaskQuery()
                .processInstanceId(instance.getId()).list()) {
            taskService.complete(task.getId());
        }

        // 多实例按"份数"计数:会签 2 人 = approve count 2 / task count 2
        Map<String, ActivityStatDto> stats = statsByActivityId(queryService.activityStats(30, null));
        assertThat(stats.get("approve").count()).isEqualTo(2);
        List<TaskStatDto> taskStats = queryService.taskStats(30, null);
        assertThat(taskStats).hasSize(1);
        assertThat(taskStats.get(0).assignee()).isEqualTo("user-1");
        assertThat(taskStats.get(0).count()).isEqualTo(2);

        // 两份都完成后实例正常结束
        assertThat(queryService.overview(30, null).completed()).isEqualTo(1);
    }

    @Test
    void keyFilterAggregatesAcrossDeployedVersions() {
        // 同一 key 部署两个版本,各跑 1 单并完成 → key 过滤跨版本聚合
        String v1 = deployApprovalProcess("dsh_ana_ver");
        String v2 = deployApprovalProcess("dsh_ana_ver");

        ProcessInstance fromV1 = runtimeService.startProcessInstanceById(v1, Map.of());
        completeTask(fromV1.getId(), "approve");
        ProcessInstance fromV2 = runtimeService.startProcessInstanceById(v2, Map.of());
        completeTask(fromV2.getId(), "approve");

        // key 过滤:两个版本的实例都命中
        AnalyticsOverviewDto byKey = queryService.overview(30, "dsh_ana_ver");
        assertThat(byKey.started()).isEqualTo(2);
        assertThat(byKey.completed()).isEqualTo(2);

        // key 不过滤时同一批数据同样命中(此库无其他实例)
        assertThat(queryService.overview(30, null).started()).isEqualTo(2);
    }

    private void completeTask(String processInstanceId, String taskDefKey) {
        Task task = taskService.createTaskQuery()
            .processInstanceId(processInstanceId)
            .taskDefinitionKey(taskDefKey)
            .singleResult();
        taskService.complete(task.getId());
    }

    private Map<String, ActivityStatDto> statsByActivityId(List<ActivityStatDto> stats) {
        return stats.stream().collect(java.util.stream.Collectors.toMap(
            ActivityStatDto::activityId, s -> s));
    }

    /** 部署最小审批流程(assignee 固定 user-1)并返回 procdefId。 */
    private String deployApprovalProcess(String key) {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="%s" name="分析测试流程" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="审批" flowable:assignee="user-1"/>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""".formatted(key);
        return deploy(key, xml);
    }

    /** 部署并行会签流程(loopCardinality=2,assignee 固定 user-1)并返回 procdefId。 */
    private void deployMultiInstanceProcess(String key) {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="%s" name="会签分析测试流程" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="会签审批" flowable:assignee="user-1">
                  <multiInstanceLoopCharacteristics isSequential="false">
                    <loopCardinality>2</loopCardinality>
                  </multiInstanceLoopCharacteristics>
                </userTask>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""".formatted(key);
        deploy(key, xml);
    }

    private String deploy(String key, String xml) {
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString(key + ".bpmn20.xml", xml)
            .deploy();
        return processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId())
            .singleResult()
            .getId();
    }
}
