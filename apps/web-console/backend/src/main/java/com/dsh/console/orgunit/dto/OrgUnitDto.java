package com.dsh.console.orgunit.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 组织树节点(部门)DTO,对应 {@code public.org_units} 表(setup guide §11)。
 *
 * @param id         部门 id
 * @param name       部门名称(同级唯一)
 * @param parentId   父部门 id;null=根节点
 * @param headUserId 部门负责人,引用 platform_users.id;可空(未配置)
 * @param sortOrder  同级排序
 * @param createdAt  创建时间
 */
public record OrgUnitDto(
    UUID id,
    String name,
    UUID parentId,
    UUID headUserId,
    int sortOrder,
    OffsetDateTime createdAt
) {
}
