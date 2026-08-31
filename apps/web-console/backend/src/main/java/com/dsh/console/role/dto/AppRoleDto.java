package com.dsh.console.role.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 应用角色 DTO,对应 {@code public.app_roles} 表(setup guide §5.2)。
 *
 * @param id              主键 UUID
 * @param appId           所属应用 ID
 * @param name            角色名(应用内唯一)
 * @param description     描述(可空)
 * @param status          状态:active(默认) / disabled
 * @param parentRoleId    父角色 ID(可空,顶级角色;上级继承下级权限并可处理下级待办)
 * @param createdAt       创建时间
 * @param createdBy       创建人
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AppRoleDto(
    UUID id,
    UUID appId,
    String name,
    String description,
    String status,
    UUID parentRoleId,
    OffsetDateTime createdAt,
    UUID createdBy
) {
}
