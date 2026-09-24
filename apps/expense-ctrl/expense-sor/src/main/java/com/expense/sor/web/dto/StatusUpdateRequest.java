package com.expense.sor.web.dto;

/** 显式状态迁移请求(管理备用入口,设计文档 §7.4) */
public record StatusUpdateRequest(String from, String to, String reason) {
}
