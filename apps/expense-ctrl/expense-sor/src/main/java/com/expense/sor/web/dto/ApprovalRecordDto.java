package com.expense.sor.web.dto;

import java.time.OffsetDateTime;

/** 审批记录(审计数据源,同一单据可多条) */
public record ApprovalRecordDto(
        String id,
        String reportId,
        String processInstanceId,
        String activityId,
        String decision,
        String comment,
        String approverId,
        String approverName,
        OffsetDateTime createdAt) {
}
