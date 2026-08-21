package com.dsh.flowable.delegate;

import com.dsh.flowable.config.DshWebProfileProperties;
import java.time.Duration;
import java.util.Map;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/**
 * 自动节点(ServiceTask)的执行委托类,通过 {@code delegateExpression} 在 BPMN 中引用。
 *
 * <p>引用方式:BPMN ServiceTask 配置 {@code flowable:delegateExpression="${dshServiceTaskDelegate}"},
 * Flowable 引擎执行该 ServiceTask 时调用本类 {@link #execute(DelegateExecution)}。
 *
 * <p>执行流程(SPEC §9.1):
 * <ol>
 *   <li>从 DelegateExecution 收集实例上下文 + 上游变量,构造 {@link AutoNodeRequest}。</li>
 *   <li>用 WebClient POST 调 DSH web profile daemon(SPEC §10.4),触发自动节点执行
 *       (LLM 调用 + skill 加载 + 脚本运行)。</li>
 *   <li>把响应 output/notes 写回 execution 变量,供下游节点按 inputSchema 消费。</li>
 *   <li>调用失败/超时抛异常,触发自动节点失败处理策略(SPEC §9.3:自动重试/转人工/异常)。</li>
 * </ol>
 *
 * <p><b>异步执行模型</b>(V1 改进):BPMN ServiceTask 配 {@code flowable:async="true"} 时,
 * 引擎不再在主流程推进线程同步调用本委派;而是在节点激活时创建 async Job,
 * 由 {@code async-executor} 线程池(application.yml {@code spring.flowable.async-executor-*})异步消费。
 * 本委派 {@link #execute} 内部仍用 WebClient 同步阻塞调用 DSH web profile,
 * 但执行线程是 async-executor 的工作线程,不阻塞流程实例推进线程。
 *
 * <p>线程池调优见 application.yml {@code spring.flowable.async-executor-core-pool-size} 等参数;
 * LLM 调用属于 I/O 密集型,线程池可适当大于 CPU 核数。
 *
 * <p>失败重试:BPMN 配 {@code flowable:failedJobRetryTimeCycle="R5/PT5M"} 时,WebClient 抛异常
 * 触发 Job 进入 {@code ACT_RU_JOB} 异常重试队列,按 ISO-8601 间隔重试 5 次;
 * 全部失败后 Job 标记 deadletter,流程实例停留于本节点等待人工干预(SPEC §9.3 转人工)。
 *
 * <p>HTTP 超时仍由 {@link DshWebProfileProperties#callTimeoutSeconds()} 控制(默认 60s);
 * LLM 平均耗时更长可调高此值。超时与 async Job 重试不冲突:超时抛异常 → 重试队列 → 下一轮重试。
 */
@Component("dshServiceTaskDelegate")
public class DshServiceTaskDelegate implements JavaDelegate {

    /** execution 变量名:存储自动节点的结构化产出(JSON 对象)。 */
    public static final String VAR_AUTO_OUTPUT = "dsh_auto_output";

    /** execution 变量名:存储自动节点的自然语言说明(下游参考)。 */
    public static final String VAR_AUTO_NOTES = "dsh_auto_notes";

    private final WebClient webClient;
    private final DshWebProfileProperties properties;

    public DshServiceTaskDelegate(WebClient.Builder webClientBuilder,
                                   DshWebProfileProperties properties) {
        this.webClient = webClientBuilder.baseUrl(properties.baseUrl()).build();
        this.properties = properties;
    }

    @Override
    public void execute(DelegateExecution execution) {
        String processInstanceId = execution.getProcessInstanceId();
        String activityId = execution.getCurrentActivityId();
        String processDefinitionId = execution.getProcessDefinitionId();
        Map<String, Object> variables = execution.getVariables();

        AutoNodeRequest request = new AutoNodeRequest(
            processInstanceId,
            processDefinitionId,
            activityId,
            variables
        );

        try {
            AutoNodeResponse response = webClient.post()
                .uri(properties.autoNodePath())
                .bodyValue(request)
                .retrieve()
                .bodyToMono(AutoNodeResponse.class)
                .block(Duration.ofSeconds(properties.callTimeoutSeconds()));

            if (response == null) {
                throw new IllegalStateException(
                    "DSH web profile returned empty response for activity " + activityId);
            }
            if (!response.success()) {
                throw new IllegalStateException(
                    "DSH web profile execution failed for activity " + activityId
                        + ": " + response.error());
            }
            execution.setVariable(VAR_AUTO_OUTPUT, response.output());
            if (response.notes() != null) {
                execution.setVariable(VAR_AUTO_NOTES, response.notes());
            }
        } catch (WebClientResponseException e) {
            throw new IllegalStateException(
                "DSH web profile call failed for activity " + activityId
                    + ": HTTP " + e.getStatusCode()
                    + " body: " + e.getResponseBodyAsString(), e);
        }
    }
}
