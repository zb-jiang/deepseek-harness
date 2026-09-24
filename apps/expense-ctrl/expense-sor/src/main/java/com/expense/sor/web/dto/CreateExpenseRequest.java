package com.expense.sor.web.dto;

import java.util.List;

/** 创建报销单请求(设计文档 §7.1,totalAmount 由 SOR 计算不信任调用方) */
public record CreateExpenseRequest(
        String title,
        String reason,
        List<ItemInput> items,
        String submitterName,
        List<String> attachmentIds) {

    public record ItemInput(String category, String amount, String occurredDate, String description) {
    }
}
