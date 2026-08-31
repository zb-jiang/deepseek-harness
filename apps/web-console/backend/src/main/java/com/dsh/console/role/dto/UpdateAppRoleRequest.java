package com.dsh.console.role.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.UUID;

/**
 * 更新应用角色请求。
 */
public record UpdateAppRoleRequest(
    @NotBlank
    String name,
    String description,
    UUID parentRoleId
) {
}
