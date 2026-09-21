package com.dsh.console.orgunit.dto;

import java.util.List;
import java.util.UUID;

/**
 * 部门树节点(嵌套 JSON,部门管理页树形展示)。
 *
 * @param id           部门 id
 * @param name         部门名称
 * @param parentId     父部门 id;null=根
 * @param headUserId   负责人用户 id;null=未配置
 * @param headUserName 负责人显示名;null=未配置
 * @param sortOrder    同级排序
 * @param children     子部门(按 sortOrder、name 排序)
 */
public record OrgUnitTreeNode(
    UUID id,
    String name,
    UUID parentId,
    UUID headUserId,
    String headUserName,
    int sortOrder,
    List<OrgUnitTreeNode> children
) {
}
