package com.dsh.console.orgunit.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.UUID;

/**
 * 部门创建/更新请求(全量覆盖写)。
 *
 * @param name       部门名称(同级唯一)
 * @param parentId   父部门 id;null=根节点
 * @param headUserId 负责人用户 id;null=不配置
 * @param sortOrder  同级排序;null=0
 */
public record SaveOrgUnitRequest(
    @NotBlank String name,
    UUID parentId,
    UUID headUserId,
    Integer sortOrder
) {
}
