package com.expense.sor.web.dto;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

/** 打款记录(一单最多一条) */
public record PaymentDto(
        String id,
        String reportId,
        @JsonSerialize(using = ToStringSerializer.class) BigDecimal amount,
        String channel,
        String comment,
        String paidBy,
        String paidName,
        OffsetDateTime paidAt) {
}
