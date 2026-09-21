package com.dsh.flowable.listener;

import java.util.Collection;
import java.util.List;
import java.util.Set;
import org.flowable.bpmn.model.BaseElement;
import org.flowable.bpmn.model.BoundaryEvent;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.FlowableListener;
import org.flowable.bpmn.model.FlowElement;
import org.flowable.bpmn.model.FlowElementsContainer;
import org.flowable.bpmn.model.ImplementationType;
import org.flowable.bpmn.model.MultiInstanceLoopCharacteristics;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.SequenceFlow;
import org.flowable.bpmn.model.ServiceTask;
import org.flowable.bpmn.model.TimerEventDefinition;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.delegate.ExecutionListener;
import org.flowable.engine.delegate.TaskListener;
import org.flowable.engine.impl.bpmn.parser.BpmnParse;
import org.flowable.engine.parse.BpmnParseHandler;
import org.springframework.util.StringUtils;

/**
 * BPMN 解析处理器(pre 位置,处理 {@link Process}):在默认 {@code ProcessParseHandler}
 * 遍历流程元素之前,递归遍历所有 {@link UserTask} 完成模型变更——
 *
 * <ol>
 *   <li>为所有 UserTask 注入 create 事件 TaskListener({@code ${dshTaskListener}});</li>
 *   <li>为配置了 {@code dsh:assignmentRule.candidateRoleId} 的多实例 userTask 补齐
 *       collection 表达式 / elementVariable / assignee,并附加 start ExecutionListener
 *       注入候选人变量;</li>
 *   <li>为配置了 {@code dsh:votingRule} 的多实例 userTask 自动写入计票完成条件
 *       (design 2026-09-15:提交端点聚合票数,达到通过/否决票数提前收);</li>
 *   <li>为配置了 {@code dsh:votingRule} 的多实例 ServiceTask(普通自动节点或 DSH
 *       backend task)写入计票完成条件并附加 end ExecutionListener 逐实例计票
 *       (2026-09-15 三种 task 统一计票);</li>
 *   <li>为配置了 {@code dsh:timeoutPolicy.duration} 的 userTask 合成 non-interrupting
 *       boundary timer + escalation service task + sequence flow。</li>
 * </ol>
 *
 * <p>必须注册在 {@code preBpmnParseHandlers} 且按 Process 粒度执行,原因有二:
 * <ul>
 *   <li>多实例的 collection/elementVariable 在 parse 时由
 *       {@code AbstractActivityBpmnParseHandler.createMultiInstanceLoopCharacteristics}
 *       拷入 {@code MultiInstanceActivityBehavior},之后改模型无效,必须在元素被解析前改;</li>
 *   <li>超时升级要向容器新增元素,必须发生在 {@code ProcessParseHandler} 开始迭代
 *       容器 live list 之前,否则触发 ConcurrentModificationException。</li>
 * </ul>
 *
 * <p>设计师在 bpmn-js 扳手菜单只选择并行/串行并填写完成条件,不写 collection;
 * 任务实际派给谁由 {@link DshMultiInstanceSetupListener} 运行时根据
 * {@code dsh:assignmentRule.candidateRoleId} 计算写入 {@code dsh_candidates_<taskId>}。
 *
 * <p>注册方式:由 {@link com.dsh.flowable.config.FlowableConfig} 通过
 * {@code EngineConfigurationConfigurer} 加入 {@code preBpmnParseHandlers}。
 */
public class DshBpmnParseHandler implements BpmnParseHandler {

    /** DshTaskListener Spring bean 名,与 {@link DshTaskListener}@Component("dshTaskListener") 一致。 */
    public static final String DSH_TASK_LISTENER_BEAN_EXPRESSION = "${dshTaskListener}";

    /** DshTaskEscalationDelegate Spring bean 名。 */
    public static final String DSH_TASK_ESCALATION_DELEGATE_BEAN_EXPRESSION = "${dshTaskEscalationDelegate}";

    /** DshMultiInstanceSetupListener Spring bean 名。 */
    public static final String DSH_MULTI_INSTANCE_SETUP_LISTENER_BEAN_EXPRESSION = "${dshMultiInstanceSetupListener}";

    /** 会签计票同意票数变量前缀(design 2026-09-15),完整变量名 {@code dsh_passCount_<taskId>}。 */
    public static final String PASS_COUNT_VARIABLE_PREFIX = "dsh_passCount_";

    /** 会签计票否决票数变量前缀(design 2026-09-15),完整变量名 {@code dsh_rejectCount_<taskId>}。 */
    public static final String REJECT_COUNT_VARIABLE_PREFIX = "dsh_rejectCount_";

    /**
     * Flowable 多实例默认下标变量名:引擎 {@code ContinueMultiInstanceOperation} 以
     * {@code setVariableLocal} 写在每个实例执行上,MI 根与流程级执行上不存在。
     * 计票 end listener 用它区分「实例完成触发」与「body 整体收工触发」
     * (后者在 MI 根执行上,无该本地变量,不重复计票)。
     */
    public static final String LOOP_COUNTER_VARIABLE = "loopCounter";

    /** DshVotingEndListener Spring bean 名(service task 逐实例计票)。 */
    public static final String DSH_VOTING_END_LISTENER_BEAN_EXPRESSION = "${dshVotingEndListener}";

    @Override
    public Collection<Class<? extends BaseElement>> getHandledTypes() {
        return Set.of(Process.class);
    }

    @Override
    public void parse(BpmnParse bpmnParse, BaseElement element) {
        if (!(element instanceof Process process)) {
            return;
        }
        processDshElements(process);
    }

    private void processDshElements(FlowElementsContainer container) {
        // 迭代快照:processUserTask 会向 container 追加超时升级元素
        for (FlowElement element : List.copyOf(container.getFlowElements())) {
            if (element instanceof UserTask userTask) {
                DshExtensionProperties props = new DshBpmnExtensionParser().parse(userTask);
                attachCreateListener(userTask);
                attachMultiInstanceSetup(userTask, props);
                attachVotingCompletionCondition(userTask, props);
                attachTimeoutEscalation(userTask, props, container);
            } else if (element instanceof ServiceTask serviceTask) {
                DshExtensionProperties props = new DshBpmnExtensionParser().parseBackendTask(serviceTask);
                if (props == null) {
                    props = new DshBpmnExtensionParser().parsePlainServiceTask(serviceTask);
                }
                attachServiceTaskVoting(serviceTask, props);
            } else if (element instanceof FlowElementsContainer nested) {
                processDshElements(nested);
            }
        }
    }

    private void attachCreateListener(UserTask userTask) {
        FlowableListener createListener = new FlowableListener();
        createListener.setImplementationType(ImplementationType.IMPLEMENTATION_TYPE_DELEGATEEXPRESSION);
        createListener.setImplementation(DSH_TASK_LISTENER_BEAN_EXPRESSION);
        createListener.setEvent(TaskListener.EVENTNAME_CREATE);
        userTask.getTaskListeners().add(createListener);
    }

    /**
     * 为配置了 candidateRoleId 的多实例 userTask 自动补齐 collection 表达式 /
     * elementVariable / assignee,并附加 start ExecutionListener 注入候选人变量。
     *
     * <p>collection 写入模型 {@code inputDataItem} 字段(对应 XML
     * {@code flowable:collection} 属性,引擎 parse 时编译为 JUEL
     * {@code collectionExpression} 运行时求值),不能用 collectionString——后者是
     * 裸字符串,Flowable 7 校验还要求额外配 flowable:collectionParser handler。
     */
    private void attachMultiInstanceSetup(UserTask userTask, DshExtensionProperties props) {
        if (!hasDshCandidateRole(userTask, props) && !hasVotingRule(userTask, props)) {
            return;
        }

        // 配了候选角色或会签计票即注入 start listener:候选人变量注入与计票变量
        // 初始化(0 起算,完成条件首次求值前必须已存在)是 DSH 产品承诺,
        // 与设计师是否自配 collection 无关
        FlowableListener startListener = new FlowableListener();
        startListener.setImplementationType(ImplementationType.IMPLEMENTATION_TYPE_DELEGATEEXPRESSION);
        startListener.setImplementation(DSH_MULTI_INSTANCE_SETUP_LISTENER_BEAN_EXPRESSION);
        startListener.setEvent(ExecutionListener.EVENTNAME_START);
        userTask.getExecutionListeners().add(startListener);

        if (!engineProvidesCollection(userTask, props)) {
            return;
        }
        MultiInstanceLoopCharacteristics loop = userTask.getLoopCharacteristics();
        loop.setInputDataItem("${" + DshMultiInstanceSetupListener.CANDIDATES_VARIABLE_PREFIX + userTask.getId() + "}");
        // 尊重设计师已手动指定的 elementVariable / assignee,不做覆盖
        if (!StringUtils.hasText(loop.getElementVariable())) {
            loop.setElementVariable(DshMultiInstanceSetupListener.CANDIDATE_ITEM_VARIABLE);
        }
        if (!StringUtils.hasText(userTask.getAssignee())) {
            userTask.setAssignee("${" + DshMultiInstanceSetupListener.CANDIDATE_ITEM_VARIABLE + "}");
        }
    }

    /**
     * 为配置了 {@code dsh:votingRule} 的多实例 userTask 自动写入计票完成条件
     * (design 2026-09-15 §4.4):票数由提交端点逐份聚合,达到通过票数或否决票数
     * 即提前收,剩余活动实例由引擎自动删除。
     *
     * <p>与 collection 补齐同理必须在 parse 前改模型(completionCondition 在 parse 时
     * 拷入 MultiInstanceActivityBehavior)。设计师手写完成条件时不覆盖(纵深防御;
     * web-console 发布校验已拒绝 votingRule 与手写完成条件并存的矛盾配置)。</p>
     */
    private void attachVotingCompletionCondition(UserTask userTask, DshExtensionProperties props) {
        if (props == null || props.votingRule() == null) {
            return;
        }
        MultiInstanceLoopCharacteristics loop = userTask.getLoopCharacteristics();
        if (loop == null) {
            return;
        }
        if (StringUtils.hasText(loop.getCompletionCondition())) {
            return;
        }
        loop.setCompletionCondition(
            buildVotingCondition(userTask.getId(), props.votingRule()));
    }

    /**
     * 为配置了 {@code dsh:votingRule} 的多实例 ServiceTask(普通自动节点或 DSH
     * backend task)写入计票完成条件并挂 end ExecutionListener(2026-09-15 三种
     * task 统一计票):每实例完成时 delegate 已写完表决变量,{@link DshVotingEndListener}
     * 读值累加计数,完成条件随后求值——Flowable {@code ParallelMultiInstanceBehavior /
     * SequentialMultiInstanceBehavior.internalLeave} 保证 {@code callActivityEndListeners}
     * 先于 {@code completionConditionSatisfied},计票对本次完成条件求值可见。
     *
     * <p>计数变量由 listener 首次计票时创建(从 0 起算),不能用 user task 的
     * start listener 预置:service task 实例创建与完成交错(同步同命令内逐实例
     * 贯穿执行 / 异步各自 job),逐实例 start 会把已累加的计数重置回 0;
     * 完成条件只在每实例完成后求值,listener 先行创建即保证变量已存在。</p>
     *
     * <p>手写完成条件时不覆盖(纵深防御;web-console 发布校验拒绝并存配置)。</p>
     */
    private void attachServiceTaskVoting(ServiceTask serviceTask, DshExtensionProperties props) {
        if (props == null || props.votingRule() == null) {
            return;
        }
        MultiInstanceLoopCharacteristics loop = serviceTask.getLoopCharacteristics();
        if (loop == null) {
            return;
        }
        FlowableListener endListener = new FlowableListener();
        endListener.setImplementationType(ImplementationType.IMPLEMENTATION_TYPE_DELEGATEEXPRESSION);
        endListener.setImplementation(DSH_VOTING_END_LISTENER_BEAN_EXPRESSION);
        endListener.setEvent(ExecutionListener.EVENTNAME_END);
        serviceTask.getExecutionListeners().add(endListener);
        if (!StringUtils.hasText(loop.getCompletionCondition())) {
            loop.setCompletionCondition(
                buildVotingCondition(serviceTask.getId(), props.votingRule()));
        }
    }

    /**
     * 计票完成条件(userTask / ServiceTask 共用):
     * {@code ${dsh_passCount_<id> >= P[ || dsh_rejectCount_<id> >= R]}}。
     */
    static String buildVotingCondition(String activityId, DshExtensionProperties.VotingRule rule) {
        String passExpr = PASS_COUNT_VARIABLE_PREFIX + activityId
            + " >= " + rule.passCount();
        return rule.rejectCount() == null
            ? "${" + passExpr + "}"
            : "${" + passExpr + " || " + REJECT_COUNT_VARIABLE_PREFIX + activityId
                + " >= " + rule.rejectCount() + "}";
    }

    /**
     * 该 userTask 是否为配置了候选规则(实体角色、虚拟角色或组织范围,design 2026-09-19)
     * 的多实例任务。start listener 注入({@link DshMultiInstanceSetupListener})以此为条件。
     */
    static boolean hasDshCandidateRole(UserTask userTask, DshExtensionProperties props) {
        if (userTask.getLoopCharacteristics() == null) {
            return false;
        }
        if (props == null || props.assignmentRule() == null) {
            return false;
        }
        DshExtensionProperties.AssignmentRule rule = props.assignmentRule();
        return StringUtils.hasText(rule.candidateRoleId())
            || StringUtils.hasText(rule.virtualRole())
            || StringUtils.hasText(rule.orgScope())
            || StringUtils.hasText(rule.fixedUnitId());
    }

    /**
     * 该 userTask 是否为配置了 {@code dsh:votingRule} 的多实例任务
     * (design 2026-09-15):start listener 初始化计票变量以此为条件。
     */
    static boolean hasVotingRule(UserTask userTask, DshExtensionProperties props) {
        return userTask.getLoopCharacteristics() != null
            && props != null && props.votingRule() != null;
    }

    /**
     * 该 userTask 的多实例 collection 是否由引擎补齐。
     *
     * <p>条件:是 {@link #hasDshCandidateRole dsh 候选角色任务} + 设计师未自配
     * loopCardinality / collection(自配时引擎不覆盖派发配置,只注入候选人变量)。
     * {@link DshProcessValidator} 用同一判定放行对应的校验错误。
     */
    static boolean engineProvidesCollection(UserTask userTask, DshExtensionProperties props) {
        if (!hasDshCandidateRole(userTask, props)) {
            return false;
        }
        MultiInstanceLoopCharacteristics loop = userTask.getLoopCharacteristics();
        return !StringUtils.hasText(loop.getLoopCardinality())
            && !StringUtils.hasText(loop.getInputDataItem())
            && !StringUtils.hasText(loop.getCollectionString());
    }

    /**
     * 在 BpmnModel 全部 process(含嵌套子流程)中按 id 查找 UserTask;
     * 供 {@link DshProcessValidator} 按校验错误的 activityId 定位元素。
     */
    static UserTask findUserTask(BpmnModel bpmnModel, String activityId) {
        for (Process process : bpmnModel.getProcesses()) {
            UserTask found = findUserTask(process, activityId);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    private static UserTask findUserTask(FlowElementsContainer container, String activityId) {
        for (FlowElement element : container.getFlowElements()) {
            if (element instanceof UserTask userTask && userTask.getId().equals(activityId)) {
                return userTask;
            }
            if (element instanceof FlowElementsContainer nested) {
                UserTask found = findUserTask(nested, activityId);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * 为配置了 timeoutPolicy duration 的 userTask 附加 non-interrupting boundary timer
     * 和 escalation service task。
     */
    private void attachTimeoutEscalation(UserTask userTask, DshExtensionProperties props,
                                         FlowElementsContainer container) {
        if (props == null || props.actionPolicy() == null || props.actionPolicy().timeoutPolicy() == null) {
            return;
        }
        DshExtensionProperties.TimeoutPolicy policy = props.actionPolicy().timeoutPolicy();
        if (!StringUtils.hasText(policy.duration())) {
            return;
        }

        String timerId = userTask.getId() + "_timeout_timer";
        String escalationTaskId = userTask.getId() + "_timeout_escalation";

        BoundaryEvent boundaryEvent = new BoundaryEvent();
        boundaryEvent.setId(timerId);
        boundaryEvent.setName(userTask.getName() + " 超时");
        boundaryEvent.setAttachedToRef(userTask);
        boundaryEvent.setCancelActivity(false);

        TimerEventDefinition timerDef = new TimerEventDefinition();
        timerDef.setTimeDuration(policy.duration());
        boundaryEvent.addEventDefinition(timerDef);

        ServiceTask escalationTask = new ServiceTask();
        escalationTask.setId(escalationTaskId);
        escalationTask.setName(userTask.getName() + " 升级");
        escalationTask.setImplementationType(ImplementationType.IMPLEMENTATION_TYPE_DELEGATEEXPRESSION);
        escalationTask.setImplementation(DSH_TASK_ESCALATION_DELEGATE_BEAN_EXPRESSION);

        SequenceFlow flow = new SequenceFlow(timerId, escalationTaskId);

        container.addFlowElement(boundaryEvent);
        container.addFlowElement(escalationTask);
        container.addFlowElement(flow);
        userTask.getBoundaryEvents().add(boundaryEvent);
    }
}
