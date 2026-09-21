package com.dsh.console.user;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.orgunit.OrgUnitJdbcRepository;
import com.dsh.console.orgunit.OrgUnitMemberJdbcRepository;
import com.dsh.console.orgunit.dto.OrgUnitDto;
import com.dsh.console.orgunit.dto.UserOrgUnitDto;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.user.dto.UserDto;
import com.dsh.console.user.dto.UpdateUserRequest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 平台用户治理业务编排。
 *
 * <p>所有写操作包装在 {@link Transactional} 内,与 {@link AuditService#record}
 * 同事务保证审计与业务一致(spec §13.2 应用隔离 + 审计不变量)。
 *
 * <p>V1 仅 system_admin 可调用本 Service 的方法(由 Controller @PreAuthorize 校验)。
 */
@Service
public class UserService {

    private final UserJdbcRepository userRepository;
    private final ApplicationJdbcRepository appRepository;
    private final FlowableRestClient flowableRestClient;
    private final AuditService auditService;
    private final OrgUnitJdbcRepository orgUnitRepository;
    private final OrgUnitMemberJdbcRepository memberRepository;

    public UserService(UserJdbcRepository userRepository,
                       ApplicationJdbcRepository appRepository,
                       FlowableRestClient flowableRestClient,
                       AuditService auditService,
                       OrgUnitJdbcRepository orgUnitRepository,
                       OrgUnitMemberJdbcRepository memberRepository) {
        this.userRepository = userRepository;
        this.appRepository = appRepository;
        this.flowableRestClient = flowableRestClient;
        this.auditService = auditService;
        this.orgUnitRepository = orgUnitRepository;
        this.memberRepository = memberRepository;
    }

    public UserDto getById(UUID userId) {
        return withOrgUnits(userRepository.findById(userId)
            .orElseThrow(() -> new NotFoundException("用户不存在: " + userId)));
    }

    /**
     * 查当前登录用户的治理记录(供前端 /api/users/me 及任务办理人反查)。
     *
     * <p>无角色要求(isAuthenticated 即可),用于 pending_approval 用户在登录后
     * 看到自己状态;active 用户可看到自己的 platformRoles 用于前端菜单渲染。
     * 任务列表中按 assignee 反查 displayName 也会用到,因此不能限定为 system_admin。
     *
     * @param authSubject JWT sub claim,即 Supabase Auth user.id
     * @return 治理记录;若 platform_users 表中无此 auth_subject,返回 null(前端按"未注册"提示)
     */
    @org.springframework.security.access.prepost.PreAuthorize("isAuthenticated()")
    public UserDto findMe(String authSubject) {
        return userRepository.findByAuthSubject(authSubject).map(this::withOrgUnits).orElse(null);
    }

    /**
     * 批量查显示名(实例/任务列表的发起人/办理人列展示用;缺失的 subject 不在返回 Map)。
     */
    public Map<String, String> findDisplayNames(java.util.Collection<String> authSubjects) {
        return userRepository.findDisplayNamesByAuthSubjects(authSubjects);
    }

    /**
     * 查流程身份的全部所属部门 id(组织维度审批路由发起身份解析,design 2026-09-19 §5.1)。
     *
     * <p>未注册/未分配部门返回空列表。
     */
    public List<UUID> findOrgUnitIdsByAuthSubject(String authSubject) {
        return memberRepository.findOrgUnitIdsByAuthSubject(authSubject);
    }

    public List<UserDto> list(String statusFilter, int offset, int limit) {
        List<UserDto> users = statusFilter == null || statusFilter.isBlank()
            ? userRepository.list(offset, limit)
            : userRepository.listByStatus(statusFilter, offset, limit);
        return withOrgUnits(users);
    }

    /**
     * 审批用户:status pending_approval → active。
     */
    @Transactional
    public UserDto approve(UUID userId, UUID approverId) {
        int rows = userRepository.approve(userId, approverId);
        if (rows == 0) {
            throw new IllegalStateException("用户审批失败:用户不存在或状态非 pending_approval");
        }
        auditService.record("USER_APPROVE", "platform_user", userId, approverId, null);
        return getById(userId);
    }

    /**
     * 禁用用户:任意状态 → disabled。
     *
     * <p>守卫:① 名下无未完成的已分配任务(运行中实例的 assignee,按 auth_subject 查);
     * ② 不是任何活跃应用的唯一活跃管理员(先增派其他管理员)。
     */
    @Transactional
    public UserDto disable(UUID userId, UUID disablerId, String reason) {
        UserDto user = getById(userId);

        // 守卫 1:未完成的已分配任务
        if (user.authSubject() != null && !user.authSubject().isBlank()) {
            int openTasks = flowableRestClient.countOpenTasksByAssignee(user.authSubject());
            if (openTasks > 0) {
                throw new IllegalStateException(
                    "用户「%s」名下尚有 %d 个未完成任务,不能禁用(先改派或等任务完成)"
                        .formatted(user.displayName(), openTasks));
            }
        }

        // 守卫 2:活跃应用的唯一活跃管理员
        List<String> soleAdminApps = new ArrayList<>();
        for (ApplicationDto app : appRepository.listByAdminUser(userId)) {
            List<UUID> otherAdmins = new ArrayList<>(app.appAdminUserIds());
            otherAdmins.remove(userId);
            if (otherAdmins.isEmpty() || userRepository.countActiveIn(otherAdmins) == 0) {
                soleAdminApps.add(app.name());
            }
        }
        if (!soleAdminApps.isEmpty()) {
            throw new IllegalStateException(
                "用户「%s」是以下活跃应用的唯一活跃管理员: %s(先增派其他管理员再禁用)"
                    .formatted(user.displayName(), String.join("、", soleAdminApps)));
        }

        int rows = userRepository.disable(userId, disablerId, reason);
        if (rows == 0) {
            throw new IllegalStateException("用户禁用失败:用户不存在或已禁用");
        }
        auditService.record("USER_DISABLE", "platform_user", userId, disablerId,
            java.util.Map.of("reason", reason == null ? "" : reason));
        return getById(userId);
    }

    /**
     * 锁定用户:任意状态 → locked。
     */
    @Transactional
    public UserDto lock(UUID userId, UUID lockerId, String reason) {
        int rows = userRepository.lock(userId, lockerId, reason);
        if (rows == 0) {
            throw new IllegalStateException("用户锁定失败:用户不存在或已锁定");
        }
        auditService.record("USER_LOCK", "platform_user", userId, lockerId,
            java.util.Map.of("reason", reason == null ? "" : reason));
        return getById(userId);
    }

    /**
     * 激活用户:disabled/locked → active。
     */
    @Transactional
    public UserDto activate(UUID userId, UUID activatorId) {
        int rows = userRepository.activate(userId);
        if (rows == 0) {
            throw new IllegalStateException("用户激活失败:用户不存在或状态非 disabled/locked");
        }
        auditService.record("USER_ACTIVATE", "platform_user", userId, activatorId, null);
        return getById(userId);
    }

    /**
     * 更新平台角色(覆盖写)。
     */
    @Transactional
    public UserDto updateRoles(UUID userId, UpdateUserRequest request, UUID updaterId) {
        userRepository.updateRoles(userId, request.platformRoles());
        auditService.record("USER_UPDATE_ROLES", "platform_user", userId, updaterId,
            java.util.Map.of("roles", request.platformRoles()));
        return getById(userId);
    }

    /**
     * 覆盖写用户的全部所属部门(组织维度审批路由,design 2026-09-19 §3/决策 10)。
     *
     * <p>orgUnitIds 为空列表表示全部移出;每个部门校验存在;被移出的部门中
     * 用户若为负责人(head_user_id)则阻止——负责人必然有本部门归属(决策 12),
     * 先更换负责人再移出。
     */
    @Transactional
    public UserDto assignOrgUnits(UUID userId, List<UUID> orgUnitIds, UUID updaterId) {
        UserDto user = getById(userId);
        List<UUID> target = orgUnitIds == null ? List.of()
            : orgUnitIds.stream().distinct().toList();
        for (UUID orgUnitId : target) {
            orgUnitRepository.findById(orgUnitId)
                .orElseThrow(() -> new NotFoundException("部门不存在: " + orgUnitId));
        }
        Set<UUID> targetSet = new HashSet<>(target);
        for (UUID currentOrgUnitId : memberRepository.findOrgUnitIdsByUser(userId)) {
            if (targetSet.contains(currentOrgUnitId)) {
                continue;
            }
            OrgUnitDto unit = orgUnitRepository.findById(currentOrgUnitId).orElse(null);
            if (unit != null && userId.equals(unit.headUserId())) {
                throw new IllegalStateException(
                    "用户是部门「%s」的负责人,先更换负责人再移出该部门".formatted(unit.name()));
            }
        }
        memberRepository.replaceForUser(userId, target);
        auditService.record("USER_ASSIGN_ORG_UNITS", "platform_user", userId, updaterId,
            Map.of("orgUnitIds", target.stream().map(UUID::toString).toList()));
        return getById(userId);
    }

    // ===== orgUnits 补齐(RowMapper 只映射表字段,部门列表按需批量补) =====

    /** 单条补齐(详情/写操作回读,一次 join 查询)。 */
    private UserDto withOrgUnits(UserDto user) {
        return withOrgUnits(user, memberRepository.listByUser(user.id()));
    }

    /** 列表批量补齐(一次 ANY(:userIds) 查齐一页,避免逐行 N+1)。 */
    private List<UserDto> withOrgUnits(List<UserDto> users) {
        Map<UUID, List<UserOrgUnitDto>> byUser = memberRepository.mapByUsers(
            users.stream().map(UserDto::id).toList());
        return users.stream()
            .map(u -> withOrgUnits(u, byUser.getOrDefault(u.id(), List.of())))
            .toList();
    }

    private static UserDto withOrgUnits(UserDto u, List<UserOrgUnitDto> orgUnits) {
        return new UserDto(
            u.id(), u.authSubject(), u.loginName(), u.displayName(), u.email(),
            u.status(), u.platformRoles(), u.createdAt(), u.createdBy(),
            u.approvedAt(), u.approvedBy(), u.disabledAt(), u.disabledBy(), u.disabledReason(),
            u.lockedAt(), u.lockedBy(), u.lockedReason(), orgUnits);
    }
}
