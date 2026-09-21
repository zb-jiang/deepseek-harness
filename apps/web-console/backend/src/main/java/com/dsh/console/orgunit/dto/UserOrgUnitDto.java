package com.dsh.console.orgunit.dto;

import java.util.UUID;

/**
 * 用户所属部门简要信息(用户管理页部门标签/身份下拉展示用)。
 *
 * @param orgUnitId 部门 id
 * @param name      部门名称
 */
public record UserOrgUnitDto(
    UUID orgUnitId,
    String name
) {
}
