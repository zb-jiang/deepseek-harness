package com.expense.sor.web.dto;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;

/** 报销单完整结构(设计文档 §7.1/§7.3 响应) */
public record ExpenseDetailDto(
        String id,
        String title,
        String reason,
        @JsonSerialize(using = ToStringSerializer.class) BigDecimal totalAmount,
        String currency,
        String status,
        String submitterId,
        String submitterName,
        String processInstanceId,
        List<ExpenseItemDto> items,
        List<AttachmentMetaDto> attachments,
        List<ApprovalRecordDto> approvalRecords,
        PaymentDto payment,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt) {
}
