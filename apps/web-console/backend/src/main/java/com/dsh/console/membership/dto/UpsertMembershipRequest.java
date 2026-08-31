package com.dsh.console.membership.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.UUID;

/**
 * 创建/更新应用成员请求(给指定用户绑定一组角色)。
 *
 * @param userId   平台用户 ID
 * @param roleIds  角色 ID 列表(必须属于同一应用,由 Service 校验)
 */
public record UpsertMembershipRequest(
    @NotNull
    UUID userId,
    @NotEmpty
    List<UUID> roleIds
) {
}
