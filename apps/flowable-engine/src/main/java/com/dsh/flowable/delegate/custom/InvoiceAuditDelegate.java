package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

/**
 * 逐张发票复核(演示版:日志代替 OCR 校验)。
 * BPMN: flowable:delegateExpression="${invoiceAuditDelegate}"
 * 多实例集合形式: flowable:collection="itemList" flowable:elementVariable="item"
 * 每个实例的 item 就是当前这张发票明细(Map),字段见 P1 上下文变量 itemList 声明。
 */
@Component("invoiceAuditDelegate")
public class InvoiceAuditDelegate implements JavaDelegate {

    @Override
    @SuppressWarnings("unchecked")
    public void execute(DelegateExecution execution) {
        Map<String, Object> item = (Map<String, Object>) execution.getVariable("item");
        ProcessLog.log(execution, "发票复核 第 {} 张: 类别={}, 金额={}, 日期={}, 说明={}",
            execution.getVariable("loopCounter"),
            item.get("expenseType"), item.get("amount"), item.get("issuedOn"), item.get("description"));
        execution.setVariable("lastAuditedItem", String.valueOf(item.get("description")));
    }
}