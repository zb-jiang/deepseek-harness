package com.expense.sor.web.dto;

/**
 * 写审批记录请求(设计文档 §7.5)。
 * approverId:JWT 调用时必须等于当前 JWT sub(否则 403);服务密钥调用时以请求体为准(§4)。
 * targetStatus:approve 时的联动迁移目标(opened/ongoing 审批通过 → ongoing;财务复核通过 → approved);
 * reject 固定迁移 rejected,本字段忽略。缺省按 ongoing 处理。
 */
public record ApprovalRecordRequest(
        String processInstanceId,
        String activityId,
        String decision,
        String targetStatus,
        String comment,
        String approverId,
        String approverName) {
}
