package com.dsh.console.user.dto;

import java.util.List;
import java.util.UUID;

/**
 * 用户所属部门覆盖写请求(多对多,org_unit_members)。
 *
 * @param orgUnitIds 部门 id 全量清单;空列表/null=全部移出(负责人守卫由后端校验)
 */
public record UpdateUserOrgUnitsRequest(List<UUID> orgUnitIds) {
}
