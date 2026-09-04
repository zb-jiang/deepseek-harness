package com.dsh.flowable.config;

import com.dsh.flowable.listener.DshBpmnParseHandler;
import com.dsh.flowable.listener.DshProcessValidator;
import java.util.ArrayList;
import java.util.List;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.parse.BpmnParseHandler;
import org.flowable.spring.SpringProcessEngineConfiguration;
import org.flowable.spring.boot.EngineConfigurationConfigurer;
import org.flowable.validation.ProcessValidatorFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Flowable 引擎自定义配置入口。
 *
 * <p>本类负责三件事:
 * <ol>
 *   <li>设置历史级别为 FULL:审计、退回/跳转(SPEC §7.4 §10.1)需要查询历史节点实例与历史任务。</li>
 *   <li>注册 {@link DshBpmnParseHandler} 到 preBpmnParseHandlers:必须在默认
 *       ProcessParseHandler 遍历元素之前完成模型变更——多实例 collection 等字段在
 *       parse 时拷入 activity behavior,超时升级要向容器新增元素(迭代中加会 CME)。
 *       handler 会为所有 UserTask 自动注入 {@link com.dsh.flowable.listener.DshTaskListener},
 *       并为 dsh 多实例任务补齐 collection/elementVariable/assignee、为超时任务合成升级路径。</li>
 *   <li>注册 {@link DshProcessValidator}:校验先于 parse handler 执行,需放行
 *       「collection 由引擎补齐」场景的 missing-collection 校验错误,其余校验保持默认。</li>
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

            // pre 位置注册 BpmnParseHandler(见类注释:模型变更必须先于默认解析)
            List<BpmnParseHandler> preHandlers = configuration.getPreBpmnParseHandlers();
            if (preHandlers == null) {
                preHandlers = new ArrayList<>();
                configuration.setPreBpmnParseHandlers(preHandlers);
            }
            preHandlers.add(new DshBpmnParseHandler());

            // 放行引擎补齐 collection 场景的校验错误,其余默认校验透传
            configuration.setProcessValidator(
                new DshProcessValidator(new ProcessValidatorFactory().createDefaultProcessValidator()));
        };
    }
}
