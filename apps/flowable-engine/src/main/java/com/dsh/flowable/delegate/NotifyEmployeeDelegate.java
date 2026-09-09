package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 通知员工报销结果(演示版:日志)。
 * BPMN: flowable:delegateExpression="${notifyEmployeeDelegate}"
 * 用于 notifyEmployee(到账) 与 notifyRejected(被拒) 两个节点。
 */
@Component("notifyEmployeeDelegate")
public class NotifyEmployeeDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyEmployeeDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        boolean rejected = !"approve".equals(execution.getVariable("approvalResult"))
            || !Boolean.TRUE.equals(execution.getVariable("financeVerified"));
        if (rejected) {
            log.info("[拒绝通知] 尊敬的 {},您的 {} 元报销申请未通过审核,流程实例 {}",
                applicantName, amount, execution.getProcessInstanceId());
        } else {
            log.info("[到账通知] 尊敬的 {},您的 {} 元报销已打款,流程实例 {}",
                applicantName, amount, execution.getProcessInstanceId());
        }
        execution.setVariable("employeeNotified", true);
    }
}