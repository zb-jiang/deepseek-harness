package com.expense.sor.web.dto;

/**
 * 写打款记录请求(设计文档 §7.6)。
 * paidBy/paidName:JWT 调用时须等于当前用户(否则 403);服务密钥调用时以请求体为准(§4)。
 */
public record PaymentRequest(String amount, String channel, String comment, String paidBy, String paidName) {
}
