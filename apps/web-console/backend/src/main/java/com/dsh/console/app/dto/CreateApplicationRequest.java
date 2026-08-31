package com.dsh.console.app.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.List;
import java.util.UUID;

/**
 * 创建应用请求。
 *
 * @param name              应用名(必填)
 * @param description       描述(可空)
 * @param icon              图标 base64 数据 URL(可空;未传时后端自动填充默认图标)
 * @param appAdminUserIds   应用管理员列表(至少一个,仅限 system_admin / app_admin 角色)
 */
public record CreateApplicationRequest(
    @NotBlank
    String name,
    String description,
    String icon,
    @NotEmpty
    List<UUID> appAdminUserIds
) {
}
