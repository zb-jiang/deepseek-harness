package com.dsh.console.app.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.UUID;

/**
 * 更新应用请求(草稿编辑;非草稿/非 active 不允许更新)。
 *
 * <p>V1 不支持状态转换(active → suspended 等),由专门端点 archive 处理。
 *
 * @param skillhubNamespace SkillHub namespace(null=不更新;空串=清除绑定;非空值
 *                          先经 SkillHub 校验 namespace 存在)
 */
public record UpdateApplicationRequest(
    @NotBlank
    String name,
    String description,
    String icon,
    List<UUID> appAdminUserIds,
    String skillhubNamespace
) {
}
