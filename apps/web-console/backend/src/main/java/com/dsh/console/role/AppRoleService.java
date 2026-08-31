package com.dsh.console.role;

import com.dsh.console.audit.AuditService;
import com.dsh.console.app.ApplicationService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.role.dto.CreateAppRoleRequest;
import com.dsh.console.role.dto.UpdateAppRoleRequest;
import com.dsh.console.security.AuthContext;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 应用角色治理业务编排。
 *
 * <p>V1 实现规则(spec §5.3 + §7.6):
 * <ul>
 *   <li>应用内角色名唯一(DB UNIQUE 约束兜底,Service 抛 DuplicateKeyException 转友好错误)。</li>
 *   <li>角色继承只在所属应用内生效:parent_role_id 必须指向同 app_id 角色,由 Service 校验。</li>
 *   <li>不允许循环引用:由 Repository {@link AppRoleJdbcRepository#wouldCreateCycle} 检测。</li>
 * </ul>
 */
@Service
public class AppRoleService {

    private final AppRoleJdbcRepository roleRepository;
    private final ApplicationService applicationService;
    private final AuditService auditService;

    public AppRoleService(AppRoleJdbcRepository roleRepository,
                          ApplicationService applicationService,
                          AuditService auditService) {
        this.roleRepository = roleRepository;
        this.applicationService = applicationService;
        this.auditService = auditService;
    }

    /**
     * 列应用下所有角色。Controller 已校验访问权限。
     */
    public List<AppRoleDto> listByApp(UUID appId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return roleRepository.listByApp(appId);
    }

    public AppRoleDto getById(UUID roleId, AuthContext auth) {
        AppRoleDto role = roleRepository.findById(roleId)
            .orElseThrow(() -> new NotFoundException("角色不存在: " + roleId));
        applicationService.checkCanAccessApp(auth, role.appId());
        return role;
    }

    @Transactional
    public AppRoleDto create(UUID appId, CreateAppRoleRequest request, UUID creatorId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        // 校验 parent_role_id 同应用
        if (request.parentRoleId() != null) {
            AppRoleDto parent = roleRepository.findById(request.parentRoleId())
                .orElseThrow(() -> new IllegalArgumentException("父角色不存在: " + request.parentRoleId()));
            if (!parent.appId().equals(appId)) {
                throw new IllegalArgumentException("父角色不属于本应用(spec §5.3 规则 2:角色继承只在所属应用内生效)");
            }
        }
        UUID roleId = roleRepository.create(appId, request.name(), request.description(),
            request.parentRoleId(), creatorId);
        auditService.record("ROLE_CREATE", "app_role", null, creatorId,
            java.util.Map.of("appId", appId, "roleId", roleId, "name", request.name()));
        return roleRepository.findById(roleId).orElseThrow();
    }

    @Transactional
    public AppRoleDto update(UUID roleId, UpdateAppRoleRequest request, UUID updaterId, AuthContext auth) {
        AppRoleDto existing = getById(roleId, auth);
        // 校验 parent_role_id 同应用 + 无循环
        if (request.parentRoleId() != null) {
            AppRoleDto parent = roleRepository.findById(request.parentRoleId())
                .orElseThrow(() -> new IllegalArgumentException("父角色不存在: " + request.parentRoleId()));
            if (!parent.appId().equals(existing.appId())) {
                throw new IllegalArgumentException("父角色不属于本应用(spec §5.3 规则 2)");
            }
            if (roleRepository.wouldCreateCycle(roleId, request.parentRoleId())) {
                throw new IllegalArgumentException("父角色形成循环引用(spec §7.6 规则 1)");
            }
        }
        roleRepository.update(roleId, request.name(), request.description(), request.parentRoleId());
        auditService.record("ROLE_UPDATE", "app_role", null, updaterId,
            java.util.Map.of("roleId", roleId, "name", request.name()));
        return roleRepository.findById(roleId).orElseThrow();
    }

    /**
     * 禁用角色(status → disabled)。V1 软删除,不删除行(BPMN 引用历史 role_id)。
     */
    @Transactional
    public AppRoleDto disable(UUID roleId, UUID disablerId, AuthContext auth) {
        AppRoleDto existing = getById(roleId, auth);
        roleRepository.setStatus(roleId, "disabled");
        auditService.record("ROLE_DISABLE", "app_role", null, disablerId,
            java.util.Map.of("roleId", roleId));
        return roleRepository.findById(roleId).orElseThrow();
    }

    /**
     * 启用角色(status → active)。
     */
    @Transactional
    public AppRoleDto activate(UUID roleId, UUID activatorId, AuthContext auth) {
        AppRoleDto existing = getById(roleId, auth);
        roleRepository.setStatus(roleId, "active");
        auditService.record("ROLE_ACTIVATE", "app_role", null, activatorId,
            java.util.Map.of("roleId", roleId));
        return roleRepository.findById(roleId).orElseThrow();
    }
}
