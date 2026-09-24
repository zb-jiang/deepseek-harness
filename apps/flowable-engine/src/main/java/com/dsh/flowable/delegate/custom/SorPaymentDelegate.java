package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.HashMap;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 登记打款:把流水写进 SOR 打款记录(规格书 §7.6),写入即迁移 paid。
 * BPMN: flowable:delegateExpression="${sorPaymentDelegate}",挂 R3/PT1M 重试。
 * 单据状态必须为 approved(SOR 校验,否则 409 走失败路径);重复调用(已有打款记录)同样 409。
 */
@Component("sorPaymentDelegate")
public class SorPaymentDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorPaymentDelegate(@Value("${sor.base-url}") String baseUrl,
                              @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    public void execute(DelegateExecution execution) {
        Map<String, Object> request = new HashMap<>();
        // 金额格式化为两位小数字符串,对齐 SOR"字符串十进制"约定
        request.put("amount", String.format("%.2f", (Double) execution.getVariable("amount")));
        request.put("channel", "银行转账");
        request.put("comment", "流水号 " + execution.getVariable("transactionId"));
        request.put("paidBy", String.valueOf(execution.getVariable("approvalApproverId")));
        request.put("paidName", String.valueOf(execution.getVariable("approvalApproverName")));
        sorClient.post()
            .uri("/api/expenses/{id}/payment", execution.getVariable("expenseId"))
            .body(request)
            .retrieve().body(Map.class);
        ProcessLog.log(execution, "登记打款 单据 {} 金额 {} 流水号 {}",
            execution.getVariable("expenseId"),
            execution.getVariable("amount"), execution.getVariable("transactionId"));
    }
}