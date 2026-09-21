package com.dsh.flowable.listener;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.ExecutionListener;
import org.springframework.stereotype.Component;

/**
 * ServiceTask(普通自动节点与 DSH backend task)的会签计票 end listener
 * (2026-09-15 三种 task 统一计票,userTask 走提交端点 {@code DshTaskCompletionService} 不经过本类)。
 *
 * <p>挂在多实例 serviceTask 的 {@code end} ExecutionListener 上,每个实例完成时触发:
 * 此时 delegate(定制代码或 DshBackendTaskDelegate 的输出映射)已写完表决变量,
 * listener 读值按 {@code dsh:votingRule} 累加 {@code dsh_passCount_<id>} /
 * {@code dsh_rejectCount_<id>};Flowable 的 {@code internalLeave} 保证本 listener
 * 先于完成条件求值,计票对本次求值可见。
 *
 * <p>触发面与守卫:Flowable 对多实例活动的 end listener 有两个触发点——
 * 每实例完成({@code callActivityEndListeners},实例执行上有 {@code loopCounter}
 * 本地变量)与 body 整体收工({@code MultiInstanceActivityBehavior.leave},MI 根
 * 执行上无该本地变量)。后者不重复计票,以 {@code loopCounter} 本地变量是否存在区分。
 *
 * <p>计数变量在首次到达时创建为 0(即使本实例表决值缺失也保证存在)——完成条件
 * 在每实例完成后求值,引用不存在的变量会让 JUEL 抛错、async job 重试也无法自愈。
 * 不能用 user task 的 start listener 预置:service task 实例创建与完成交错
 * (同步同命令逐实例贯穿 / 异步各自 job),逐实例 start 会把已累加计数重置回 0。
 */
@Component("dshVotingEndListener")
public class DshVotingEndListener implements ExecutionListener {

    private final DshExtensionResolver resolver;

    public DshVotingEndListener(DshExtensionResolver resolver) {
        this.resolver = resolver;
    }

    @Override
    public void notify(DelegateExecution execution) {
        // body 整体收工触发(MI 根执行,无 loopCounter 本地变量)不重复计票
        if (execution.getVariableLocal(DshBpmnParseHandler.LOOP_COUNTER_VARIABLE) == null) {
            return;
        }
        String procdefId = execution.getProcessDefinitionId();
        String activityId = execution.getCurrentActivityId();
        if (procdefId == null || activityId == null) {
            return;
        }
        DshExtensionProperties props = resolver.resolveServiceTaskProperties(procdefId, activityId);
        if (props == null || props.votingRule() == null) {
            return;
        }
        DshExtensionProperties.VotingRule rule = props.votingRule();
        String passVar = DshBpmnParseHandler.PASS_COUNT_VARIABLE_PREFIX + activityId;
        String rejectVar = DshBpmnParseHandler.REJECT_COUNT_VARIABLE_PREFIX + activityId;

        // 计数变量缺失时先创建为 0(与本实例是否计票无关):完成条件求值引用的
        // 变量必须已存在,否则 JUEL 抛错且重试无法自愈
        Object currentPass = ensureCounter(execution, passVar);
        Object currentReject = ensureCounter(execution, rejectVar);

        Object value = execution.getVariable(rule.variable());
        if (value == null) {
            // 表决变量缺失(delegate 未写):该实例不计票、不阻断完成
            return;
        }
        String normalized = String.valueOf(value).trim();
        boolean isPass = normalized.equals(rule.passValue().trim());
        long next = (isPass
            ? (currentPass instanceof Number n ? n.longValue() : 0)
            : (currentReject instanceof Number n ? n.longValue() : 0)) + 1;
        execution.setVariable(isPass ? passVar : rejectVar, next);
    }

    /** 读计数变量,不存在则创建为 0 并返回 null(表示刚创建)。 */
    private static Object ensureCounter(DelegateExecution execution, String name) {
        Object current = execution.getVariable(name);
        if (current == null) {
            execution.setVariable(name, 0L);
        }
        return current;
    }
}
