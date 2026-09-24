package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 读取报销单:调 SOR GET /api/expenses/{expenseId}(规格书 §7.3),把单据概要与当前状态写进流程变量;
 * 随后 PUT /api/expenses/{expenseId}/process-instance 回写流程实例 id(规格书 §8,幂等,重试安全)。
 * BPMN: flowable:async="true" + flowable:delegateExpression="${sorExpenseDelegate}",挂 R3/PT1M 重试。
 * X-Service-Key 服务间认证;HTTP/状态失败抛异常走 async Job 重试。
 */
@Component("sorExpenseDelegate")
public class SorExpenseDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorExpenseDelegate(@Value("${sor.base-url}") String baseUrl,
                              @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    @SuppressWarnings("unchecked")
    public void execute(DelegateExecution execution) {
        String expenseId = (String) execution.getVariable("expenseId");
        Map<String, Object> body = sorClient.get().uri("/api/expenses/{id}", expenseId)
            .retrieve().body(Map.class);
        Map<String, Object> data = (Map<String, Object>) body.get("data");
        // 当前状态写进流程变量,后续节点(prompt/网关)可读
        execution.setVariable("expenseStatus", data.get("status"));
        execution.setVariable("expenseTitle", data.get("title"));
        execution.setVariable("reason", data.get("reason"));
        // SOR 金额是字符串十进制,流程变量 amount 声明为 float
        execution.setVariable("amount", Double.valueOf(String.valueOf(data.get("totalAmount"))));
        List<Map<String, Object>> items = (List<Map<String, Object>>) data.get("items");
        List<Map<String, Object>> itemList = new ArrayList<>();
        for (Map<String, Object> it : items) {
            // SOR 明细字段(category/occurredDate)映射为流程明细字段(expenseType/issuedOn)
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("expenseType", it.get("category"));
            row.put("amount", Double.valueOf(String.valueOf(it.get("amount"))));
            row.put("issuedOn", it.get("occurredDate"));
            row.put("description", it.get("description"));
            itemList.add(row);
        }
        execution.setVariable("itemList", itemList);
        execution.setVariable("itemCount", itemList.size());
        // 回写流程实例 id(GUI/列表可从单据跳流程;同实例重试回写幂等)
        sorClient.put().uri("/api/expenses/{id}/process-instance", expenseId)
            .body(Map.of("processInstanceId", execution.getProcessInstanceId()))
            .retrieve().body(Map.class);
        ProcessLog.log(execution, "读取报销单 {} 标题={} 金额={} 明细 {} 行 状态={}",
            expenseId, data.get("title"), data.get("totalAmount"), itemList.size(), data.get("status"));
    }
}