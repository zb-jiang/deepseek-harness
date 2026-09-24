package com.expense.sor.web.dto;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

/** 报销单列表条目(不含明细/附件/审批/打款,见设计文档 §7.8) */
public record ExpenseSummaryDto(
        String id,
        String title,
        String reason,
        @JsonSerialize(using = ToStringSerializer.class) BigDecimal totalAmount,
        String currency,
        String status,
        String submitterId,
        String submitterName,
        String processInstanceId,
        OffsetDateTime createdAt) {
}
