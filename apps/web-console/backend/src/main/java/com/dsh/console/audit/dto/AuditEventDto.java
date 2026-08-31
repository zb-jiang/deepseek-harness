package com.dsh.console.audit.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;

/**
 * 审计事件 DTO,对应 {@code public.audit_events} 表(setup guide §4)。
 *
 * <p>所有写操作 Controller/Service 写审计;读操作查询审计页。
 *
 * @param id            主键 UUID
 * @param eventType     事件类型(机器可读,如 USER_APPROVE / APP_CREATE / WORKFLOW_PUBLISH)
 * @param targetUserId  目标用户 ID(可空,如目标是 application 则存到 details.target_id)
 * @param operatorId    操作人 ID(对应 platform_users.id)
 * @param details       详情 JSONB(可空)
 * @param createdAt     发生时间
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AuditEventDto(
    UUID id,
    String eventType,
    UUID targetUserId,
    UUID operatorId,
    Map<String, Object> details,
    OffsetDateTime createdAt
) {
}
