package com.dsh.flowable.listener;

import java.util.Collection;
import java.util.Set;
import org.flowable.bpmn.model.BaseElement;
import org.flowable.bpmn.model.FlowableListener;
import org.flowable.bpmn.model.ImplementationType;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.delegate.TaskListener;
import org.flowable.engine.impl.bpmn.parser.BpmnParse;
import org.flowable.engine.parse.BpmnParseHandler;

/**
 * BPMN 解析处理器:为所有 {@link UserTask} 在部署时自动注入 create event TaskListener。
 *
 * <p>避免依赖 Web Console 在每个 userTask 上显式声明 {@code <flowable:taskListener>};
 * 所有 userTask 部署时自动绑定 {@link DshTaskListener} 通过
 * {@code delegateExpression="${dshTaskListener}"}(Spring bean),Flowable 引擎执行时
 * 由 Spring 容器解析。
 *
 * <p>注册方式:由 {@link com.dsh.flowable.config.FlowableConfig} 通过
 * {@code EngineConfigurationConfigurer} 加入 {@code postBpmnParseHandlers}。
 *
 * <p>不实现 {@code getHandledTypes()} 的旧 API,改用 {@code getHandledClasses()}(Flowable 7)。
 * 实际 Flowable 7 中 {@link BpmnParseHandler} 接口仍保留 {@code getHandledTypes()} 方法名,
 * 返回元素类型集合;此处实现按 Flowable 7 OSS 文档示例。
 */
public class DshBpmnParseHandler implements BpmnParseHandler {

    /** DshTaskListener Spring bean 名,与 {@link DshTaskListener}@Component("dshTaskListener") 一致。 */
    public static final String DSH_TASK_LISTENER_BEAN_EXPRESSION = "${dshTaskListener}";

    @Override
    public Collection<Class<? extends BaseElement>> getHandledTypes() {
        return Set.of(UserTask.class);
    }

    @Override
    public void parse(BpmnParse bpmnParse, BaseElement element) {
        if (!(element instanceof UserTask userTask)) {
            return;
        }
        FlowableListener createListener = new FlowableListener();
        createListener.setImplementationType(ImplementationType.IMPLEMENTATION_TYPE_DELEGATEEXPRESSION);
        createListener.setImplementation(DSH_TASK_LISTENER_BEAN_EXPRESSION);
        createListener.setEvent(TaskListener.EVENTNAME_CREATE);
        userTask.getTaskListeners().add(createListener);
    }
}
