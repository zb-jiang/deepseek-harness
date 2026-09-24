package com.expense.sor.web.dto;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;

import java.math.BigDecimal;
import java.time.LocalDate;

/** 单条报销明细 */
public record ExpenseItemDto(
        String id,
        String category,
        @JsonSerialize(using = ToStringSerializer.class) BigDecimal amount,
        LocalDate occurredDate,
        String description) {
}
