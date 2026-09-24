package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

/**
 * 通用日志通知(演示版:所有通知/归档节点共用,按当前活动 id 区分场景)。
 * BPMN: flowable:delegateExpression="${logDelegate}"
 * 用于 notifyPayment/notifyDone/archive/urgeFinance/notifyRejected(P1)
 * 与 archive/notifyDone/notifyRejected(P2)。
 */
@Component("logDelegate")
public class LogDelegate implements JavaDelegate {

    @Override
    public void execute(DelegateExecution execution) {
        Object summary = execution.hasVariable("summary") ? execution.getVariable("summary") : null;
        ProcessLog.log(execution, "通知: {}",
            summary == null ? "变量: title=" + execution.getVariable("title") : summary);
        execution.setVariable("lastNotifyActivity", execution.getCurrentActivityId());
    }
}