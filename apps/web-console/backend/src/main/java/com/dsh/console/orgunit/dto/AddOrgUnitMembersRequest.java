package com.dsh.console.orgunit.dto;

import jakarta.validation.constraints.NotEmpty;
import java.util.List;
import java.util.UUID;

/**
 * 批量加入部门成员请求。
 *
 * @param userIds 待加入的用户 id 清单(已在本部门的 id 幂等跳过)
 */
public record AddOrgUnitMembersRequest(
    @NotEmpty List<UUID> userIds) {
}
