package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 通知出纳打款(演示版:日志代替真实通知渠道)。
 * BPMN: flowable:delegateExpression="${notifyPaymentDelegate}"
 */
@Component("notifyPaymentDelegate")
public class NotifyPaymentDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyPaymentDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        log.info("[打款通知] 请为 {} 打款 {} 元,流程实例 {}",
            applicantName, amount, execution.getProcessInstanceId());
        execution.setVariable("paymentNotified", true);
    }
}