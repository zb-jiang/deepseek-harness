package com.dsh.console.user.dto;

import com.dsh.console.orgunit.dto.UserOrgUnitDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 平台用户治理记录 DTO,对应 {@code public.platform_users} 表。
 *
 * <p>表字段由 JdbcTemplate RowMapper 映射;{@code orgUnits} 不在表上,
 * 由 Service 批量补齐(空表由调用方按"未分配"展示)。
 *
 * @param id               主键 UUID
 * @param authSubject     Supabase Auth user.id(对应 JWT sub claim)
 * @param loginName       平台登录名(唯一)
 * @param displayName     显示名称
 * @param email           邮箱(唯一)
 * @param status          状态:pending_approval / active / disabled / locked
 * @param platformRoles   平台角色数组(system_admin / app_admin / normal_user)
 * @param createdAt       创建时间
 * @param createdBy       创建人(可空,JIT 建档与管理员手工创建时为 null)
 * @param approvedAt      审批时间
 * @param approvedBy      审批人
 * @param disabledAt      禁用时间
 * @param disabledBy      禁用人
 * @param disabledReason  禁用原因
 * @param lockedAt        锁定时间
 * @param lockedBy        锁定人
 * @param lockedReason     锁定原因
 * @param orgUnits        所属部门列表(多对多,org_unit_members;RowMapper 置空,Service 补齐)
 */
public record UserDto(
    UUID id,
    String authSubject,
    String loginName,
    String displayName,
    String email,
    String status,
    List<String> platformRoles,
    OffsetDateTime createdAt,
    UUID createdBy,
    OffsetDateTime approvedAt,
    UUID approvedBy,
    OffsetDateTime disabledAt,
    UUID disabledBy,
    String disabledReason,
    OffsetDateTime lockedAt,
    UUID lockedBy,
    String lockedReason,
    List<UserOrgUnitDto> orgUnits
) {
}
