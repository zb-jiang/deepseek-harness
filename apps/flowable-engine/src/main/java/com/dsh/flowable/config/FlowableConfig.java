package com.dsh.flowable.config;

import com.dsh.flowable.listener.DshBpmnParseHandler;
import java.util.ArrayList;
import java.util.List;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.parse.BpmnParseHandler;
import org.flowable.spring.SpringProcessEngineConfiguration;
import org.flowable.spring.boot.EngineConfigurationConfigurer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Flowable 引擎自定义配置入口。
 *
 * <p>本类负责两件事:
 * <ol>
 *   <li>设置历史级别为 FULL:审计、退回/跳转(SPEC §7.4 §10.1)需要查询历史节点实例与历史任务。</li>
 *   <li>注册 {@link DshBpmnParseHandler} 到 postBpmnParseHandlers:让所有 UserTask 部署时
 *       自动注入 {@link com.dsh.flowable.listener.DshTaskListener} Spring bean,
 *       在 create 事件触发时把 dsh 元数据解析注入 task-local 变量。</li>
 * </ol>
 *
 * <p>其他扩展点(V2):异步执行器调优(LLM 长耗时任务 Job 线程池)。
 */
@Configuration
public class FlowableConfig {

    @Bean
    public EngineConfigurationConfigurer<SpringProcessEngineConfiguration> dshEngineConfigurer() {
        return configuration -> {
            // V1 历史级别 FULL:审计、退回/跳转(§7.4 §10.1)需要查询历史节点实例与历史任务
            configuration.setHistoryLevel(HistoryLevel.FULL);

            // 注册 BpmnParseHandler,为所有 UserTask 自动注入 DshTaskListener(create 事件)
            List<BpmnParseHandler> postHandlers = configuration.getPostBpmnParseHandlers();
            if (postHandlers == null) {
                postHandlers = new ArrayList<>();
                configuration.setPostBpmnParseHandlers(postHandlers);
            }
            postHandlers.add(new DshBpmnParseHandler());
        };
    }
}
