package com.dsh.console.orgunit.dto;

import java.util.UUID;

/**
 * 部门成员明细(部门管理页成员面板行)。
 *
 * @param userId      用户 id(platform_users.id)
 * @param loginName   登录名
 * @param displayName 显示名
 * @param status      用户状态(active/disabled/pending_approval)
 */
public record OrgUnitMemberDto(
    UUID userId,
    String loginName,
    String displayName,
    String status) {
}
