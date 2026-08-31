package com.dsh.console.app.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 应用 DTO,对应 {@code public.applications} 表(setup guide §5.1)。
 *
 * @param id                主键 UUID
 * @param name              应用名
 * @param description       描述(可空)
 * @param icon              图标 base64 数据 URL(可空;后端自动填充默认图标)
 * @param status            状态:draft / active / suspended / archived
 * @param appAdminUserIds   应用管理员列表(platform_users.id 数组,至少一个)
 * @param createdAt          创建时间
 * @param createdBy          创建人
 * @param archivedAt         归档时间
 * @param archivedBy         归档人
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApplicationDto(
    UUID id,
    String name,
    String description,
    String icon,
    String status,
    List<UUID> appAdminUserIds,
    OffsetDateTime createdAt,
    UUID createdBy,
    OffsetDateTime archivedAt,
    UUID archivedBy
) {
}
