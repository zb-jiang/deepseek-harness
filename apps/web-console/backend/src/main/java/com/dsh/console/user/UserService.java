package com.dsh.console.user;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.user.dto.UserDto;
import com.dsh.console.user.dto.UpdateUserRequest;
import com.dsh.console.user.dto.UserActionRequest;
import java.util.ArrayList;
import java.util.List;
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

    public UserService(UserJdbcRepository userRepository,
                       ApplicationJdbcRepository appRepository,
                       FlowableRestClient flowableRestClient,
                       AuditService auditService) {
        this.userRepository = userRepository;
        this.appRepository = appRepository;
        this.flowableRestClient = flowableRestClient;
        this.auditService = auditService;
    }

    public UserDto getById(UUID userId) {
        return userRepository.findById(userId)
            .orElseThrow(() -> new NotFoundException("用户不存在: " + userId));
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
        return userRepository.findByAuthSubject(authSubject).orElse(null);
    }

    public List<UserDto> list(String statusFilter, int offset, int limit) {
        if (statusFilter == null || statusFilter.isBlank()) {
            return userRepository.list(offset, limit);
        }
        return userRepository.listByStatus(statusFilter, offset, limit);
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
}
