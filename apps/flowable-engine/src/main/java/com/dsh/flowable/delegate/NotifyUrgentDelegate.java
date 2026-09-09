package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 24h 超时催打出纳(演示版:日志)。
 * BPMN: flowable:delegateExpression="${notifyUrgentDelegate}"
 */
@Component("notifyUrgentDelegate")
public class NotifyUrgentDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyUrgentDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        log.info("[催打提醒] 报销人 {} 的 {} 元报销已超过 24h 未打款,流程实例 {}",
            applicantName, amount, execution.getProcessInstanceId());
        execution.setVariable("urgentNotified", true);
    }
}