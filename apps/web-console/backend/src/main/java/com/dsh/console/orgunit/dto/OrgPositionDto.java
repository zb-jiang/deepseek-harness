package com.dsh.console.orgunit.dto;

import java.util.List;
import java.util.UUID;

/**
 * 当前用户的组织位置(发起身份选择,design 2026-09-19 §5.1)。
 *
 * @param orgUnitId    部门 id
 * @param orgUnitName  部门名称
 * @param pathToRoot   到根的部门名路径,根在前(如 [总公司, 华东区, A 部门])
 */
public record OrgPositionDto(
    UUID orgUnitId,
    String orgUnitName,
    List<String> pathToRoot
) {
}
