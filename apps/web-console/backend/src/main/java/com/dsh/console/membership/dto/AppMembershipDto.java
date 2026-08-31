package com.dsh.console.membership.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 应用成员 DTO,对应 {@code public.app_memberships} 表(setup guide §5.3)。
 *
 * @param id          主键 UUID
 * @param appId       所属应用 ID
 * @param userId      平台用户 ID(引用 platform_users.id)
 * @param roleIds     绑定的角色 ID 数组(引用 app_roles.id,应用层校验完整性)
 * @param status      状态:active(默认) / disabled
 * @param grantedAt   授权时间
 * @param grantedBy   授权人(可空)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AppMembershipDto(
    UUID id,
    UUID appId,
    UUID userId,
    List<UUID> roleIds,
    String status,
    OffsetDateTime grantedAt,
    UUID grantedBy
) {
}
