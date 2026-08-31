package com.dsh.console.user.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;

/**
 * 更新用户请求(更新 platform_roles;其他治理状态由专门端点 approve/disable/lock 改)。
 *
 * @param platformRoles  新的平台角色列表(覆盖写)
 */
public record UpdateUserRequest(
    @NotNull
    List<String> platformRoles
) {
}
