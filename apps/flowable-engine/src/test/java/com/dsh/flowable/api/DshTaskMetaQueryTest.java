package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshExtensionPropertiesCache;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.dsh.flowable.repository.DshUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.runtime.ProcessInstance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * 员工工作台待办元数据补齐回归测试:验证 {@code GET /dsh/tasks/my-tasks} 与
 * {@code GET /dsh/tasks/{taskId}} 返回的 TaskDto 带流程定义名与发起人信息
 * ({@link DshTaskMetaService} 批量补齐,供待办卡片「流程名 + 张三发起」人读展示)。
 *
 * <p>用 Standalone 内存引擎(H2)直接构造 controller(不经 Spring 上下文);
 * {@code platform_users} 表在 H2 中不存在,{@link DshUserRepository} 注入 stub。
 * H2 库名不带 DB_CLOSE_DELAY:每个测试方法独立库,避免上一方法的运行中任务
 * 泄漏到下一方法的 my-tasks 全量查询。
 */
class DshTaskMetaQueryTest {

    private ProcessEngine processEngine;
    private DshTaskController controller;

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-task-meta-test");
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
        controller = new DshTaskController(
            processEngine.getTaskService(),
            new ObjectMapper(),
            new DshTaskCompletionService(processEngine.getTaskService(), resolver),
            new DshTaskMetaService(
                processEngine.getRepositoryService(),
                processEngine.getRuntimeService(),
                new StubUserRepository()));
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void myTasksCarryProcessNameAndStarterDisplayName() {
        String procdefId = deployApprovalProcess();
        processEngine.getIdentityService().setAuthenticatedUserId("user-9");
        ProcessInstance instance = processEngine.getRuntimeService()
            .startProcessInstanceById(procdefId);
        processEngine.getIdentityService().setAuthenticatedUserId(null);

        List<TaskDto> mine = controller.getMyTasks(jwtFor("user-1"));
        assertThat(mine).hasSize(1);
        TaskDto dto = mine.get(0);
        assertThat(dto.processInstanceId()).isEqualTo(instance.getId());
        assertThat(dto.taskDefinitionKey()).isEqualTo("approve");
        assertThat(dto.processDefinitionName()).isEqualTo("元数据补齐测试流程");
        assertThat(dto.startUserId()).isEqualTo("user-9");
        assertThat(dto.startUserName()).isEqualTo("张三");

        // my-tasks 按 assignee 过滤:非处理人视角为空
        assertThat(controller.getMyTasks(jwtFor("someone-else"))).isEmpty();

        // 单任务详情同样带元数据
        TaskDto detail = controller.getTask(dto.id(), jwtFor("user-1"));
        assertThat(detail.processDefinitionName()).isEqualTo("元数据补齐测试流程");
        assertThat(detail.startUserName()).isEqualTo("张三");
    }

    @Test
    void starterWithoutPlatformUserFallsBackToNullDisplayName() {
        String procdefId = deployApprovalProcess();
        processEngine.getIdentityService().setAuthenticatedUserId("user-404");
        processEngine.getRuntimeService().startProcessInstanceById(procdefId);
        processEngine.getIdentityService().setAuthenticatedUserId(null);

        List<TaskDto> mine = controller.getMyTasks(jwtFor("user-1"));
        assertThat(mine).hasSize(1);
        assertThat(mine.get(0).startUserId()).isEqualTo("user-404");
        assertThat(mine.get(0).startUserName()).isNull();
    }

    /**
     * 生产启动路径(web-console 经 REST)不写 startUserId,发起人取应用隔离变量
     * dsh_applicant_user_id 回退:REST 启动不带认证用户上下文,
     * 待办卡片发起人依赖该回退才有值。
     */
    @Test
    void startUserFallsBackToApplicantVariableWhenStartUserIdMissing() {
        String procdefId = deployApprovalProcess();
        // 不设 authenticated user,模拟 web-console REST 启动:startUserId 为空
        processEngine.getRuntimeService()
            .startProcessInstanceById(procdefId, null,
                Map.of("dsh_applicant_user_id", "user-9"));

        List<TaskDto> mine = controller.getMyTasks(jwtFor("user-1"));
        assertThat(mine).hasSize(1);
        assertThat(mine.get(0).startUserId()).isEqualTo("user-9");
        assertThat(mine.get(0).startUserName()).isEqualTo("张三");
    }

    private Jwt jwtFor(String subject) {
        Instant now = Instant.now();
        return new Jwt(
            "test-token",
            now,
            now.plusSeconds(60),
            Map.of("alg", "none"),
            Map.of("sub", subject));
    }

    /** 部署一个最小审批流程(assignee=user-1)并返回 procdefId。 */
    private String deployApprovalProcess() {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="dsh_task_meta_process" name="元数据补齐测试流程" isExecutable="true">
                <startEvent id="start"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="approve"/>
                <userTask id="approve" name="审批" flowable:assignee="user-1"/>
                <sequenceFlow id="flow2" sourceRef="approve" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""";
        Deployment deployment = processEngine.getRepositoryService().createDeployment()
            .addString("dsh_task_meta_process.bpmn20.xml", xml)
            .deploy();
        return processEngine.getRepositoryService().createProcessDefinitionQuery()
            .deploymentId(deployment.getId())
            .singleResult()
            .getId();
    }

    /** H2 无 platform_users 表;固定映射 user-9 → 张三,其余 id 不命中。 */
    private static final class StubUserRepository extends DshUserRepository {

        StubUserRepository() {
            super(null);
        }

        @Override
        public Map<String, String> findDisplayNamesByAuthSubjects(Collection<String> authSubjects) {
            return authSubjects.contains("user-9") ? Map.of("user-9", "张三") : Map.of();
        }
    }
}
