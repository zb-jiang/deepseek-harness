package com.dsh.console.membership;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.membership.dto.AppMembershipDto;
import com.dsh.console.membership.dto.UpsertMembershipRequest;
import com.dsh.console.role.AppRoleJdbcRepository;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.security.AuthContext;
import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.user.dto.UserDto;
import com.dsh.console.workflow.WorkflowInstanceGuard;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 应用成员治理业务编排。
 *
 * <p>V1 实现规则(spec §5.4):
 * <ul>
 *   <li>同一用户同一应用只有一条有效记录(DB UNIQUE 约束兜底)。</li>
 *   <li>role_ids 必须属于同一应用(spec §12.10 应用隔离不变量,Service 校验)。</li>
 *   <li>成员状态失效后,该用户不再能访问该应用中的待办和资源。</li>
 * </ul>
 *
 * <p>对"同一用户在多个应用"场景,各应用独立一条 membership 记录(spec §13.4 应用隔离)。
 */
@Service
public class AppMembershipService {

    private final AppMembershipJdbcRepository membershipRepository;
    private final ApplicationService applicationService;
    private final AppRoleJdbcRepository roleRepository;
    private final UserJdbcRepository userRepository;
    private final WorkflowInstanceGuard workflowInstanceGuard;
    private final AuditService auditService;

    public AppMembershipService(AppMembershipJdbcRepository membershipRepository,
                                ApplicationService applicationService,
                                AppRoleJdbcRepository roleRepository,
                                UserJdbcRepository userRepository,
                                WorkflowInstanceGuard workflowInstanceGuard,
                                AuditService auditService) {
        this.membershipRepository = membershipRepository;
        this.applicationService = applicationService;
        this.roleRepository = roleRepository;
        this.userRepository = userRepository;
        this.workflowInstanceGuard = workflowInstanceGuard;
        this.auditService = auditService;
    }

    public List<AppMembershipDto> listByApp(UUID appId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return membershipRepository.listByApp(appId);
    }

    public AppMembershipDto getById(UUID membershipId, AuthContext auth) {
        AppMembershipDto m = membershipRepository.findById(membershipId)
            .orElseThrow(() -> new NotFoundException("成员记录不存在: " + membershipId));
        applicationService.checkCanAccessApp(auth, m.appId());
        return m;
    }

    /**
     * 创建或更新成员(upsert 语义:存在则更新 role_ids,不存在则创建)。
     */
    @Transactional
    public AppMembershipDto upsert(UUID appId, UpsertMembershipRequest request,
                                   UUID granterId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        // 校验用户存在且 active
        UserDto user = userRepository.findById(request.userId())
            .orElseThrow(() -> new IllegalArgumentException("用户不存在: " + request.userId()));
        if (!"active".equalsIgnoreCase(user.status())) {
            throw new IllegalArgumentException("用户状态非 active,无法加入应用: " + user.status());
        }
        // 校验所有 role_ids 属于本应用(spec §12.10 应用隔离不变量)
        for (UUID roleId : request.roleIds()) {
            AppRoleDto role = roleRepository.findById(roleId)
                .orElseThrow(() -> new IllegalArgumentException("角色不存在: " + roleId));
            if (!role.appId().equals(appId)) {
                throw new IllegalArgumentException(
                    "角色 " + roleId + " 不属于本应用(spec §12.10 应用隔离不变量)");
            }
        }

        UUID[] roleIdsArr = request.roleIds().toArray(new UUID[0]);
        return membershipRepository.findByAppAndUser(appId, request.userId())
            .map(existing -> {
                membershipRepository.updateRoleIds(existing.id(), roleIdsArr);
                auditService.record("MEMBERSHIP_UPDATE", "app_membership", null, granterId,
                    java.util.Map.of("appId", appId, "membershipId", existing.id(),
                        "userId", request.userId(), "roleIds", request.roleIds()));
                return membershipRepository.findById(existing.id()).orElseThrow();
            })
            .orElseGet(() -> {
                UUID membershipId = membershipRepository.create(appId, request.userId(),
                    roleIdsArr, granterId);
                auditService.record("MEMBERSHIP_CREATE", "app_membership", null, granterId,
                    java.util.Map.of("appId", appId, "membershipId", membershipId,
                        "userId", request.userId(), "roleIds", request.roleIds()));
                return membershipRepository.findById(membershipId).orElseThrow();
            });
    }

    /**
     * 禁用成员(状态 → disabled,不删行,保留历史)。
     *
     * <p>守卫:该成员在本应用名下无未完成的已认领任务(成员资格失效后
     * 看不到该应用待办,任务会卡死;未认领的候选任务可由其他成员认领,不阻塞)。
     */
    @Transactional
    public AppMembershipDto disable(UUID membershipId, UUID disablerId, AuthContext auth) {
        AppMembershipDto existing = getById(membershipId, auth);
        UserDto user = userRepository.findById(existing.userId())
            .orElseThrow(() -> new IllegalArgumentException("用户不存在: " + existing.userId()));
        if (user.authSubject() != null && !user.authSubject().isBlank()) {
            int openTasks = workflowInstanceGuard.countOpenTasksInApp(existing.appId(), user.authSubject());
            if (openTasks > 0) {
                throw new IllegalStateException(
                    "成员「%s」在本应用名下尚有 %d 个未完成任务,不能停用(先改派或等任务完成)"
                        .formatted(user.displayName(), openTasks));
            }
        }
        membershipRepository.setStatus(membershipId, "disabled");
        auditService.record("MEMBERSHIP_DISABLE", "app_membership", null, disablerId,
            java.util.Map.of("membershipId", membershipId, "appId", existing.appId(),
                "userId", existing.userId()));
        return membershipRepository.findById(membershipId).orElseThrow();
    }

    /**
     * 启用成员(状态 → active)。
     */
    @Transactional
    public AppMembershipDto activate(UUID membershipId, UUID activatorId, AuthContext auth) {
        AppMembershipDto existing = getById(membershipId, auth);
        membershipRepository.setStatus(membershipId, "active");
        auditService.record("MEMBERSHIP_ACTIVATE", "app_membership", null, activatorId,
            java.util.Map.of("membershipId", membershipId, "appId", existing.appId(),
                "userId", existing.userId()));
        return membershipRepository.findById(membershipId).orElseThrow();
    }
}
