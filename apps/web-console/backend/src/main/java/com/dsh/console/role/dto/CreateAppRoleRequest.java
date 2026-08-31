package com.dsh.console.role.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.UUID;

/**
 * 创建应用角色请求。
 *
 * @param name           角色名(应用内唯一,必填)
 * @param description    描述(可空)
 * @param parentRoleId   父角色 ID(可空;必须指向同一应用内的角色,由 Service 校验)
 */
public record CreateAppRoleRequest(
    @NotBlank
    String name,
    String description,
    UUID parentRoleId
) {
}
