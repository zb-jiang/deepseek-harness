package com.dsh.console.role;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.role.dto.CreateAppRoleRequest;
import com.dsh.console.role.dto.UpdateAppRoleRequest;
import com.dsh.console.security.AuthContext;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 应用角色治理 REST 端点。
 *
 * <p>路径嵌在 {@code /api/applications/{appId}/roles} 下,Controller 入口校验访问权限。
 */
@RestController
@RequestMapping("/api/applications/{appId}/roles")
@PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
public class AppRoleController {

    private final AppRoleService appRoleService;

    public AppRoleController(AppRoleService appRoleService) {
        this.appRoleService = appRoleService;
    }

    @GetMapping
    public ApiResponse<List<AppRoleDto>> list(@PathVariable UUID appId,
                                              @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.listByApp(appId, auth));
    }

    @GetMapping("/{roleId}")
    public ApiResponse<AppRoleDto> get(@PathVariable UUID appId,
                                       @PathVariable UUID roleId,
                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.getById(roleId, auth));
    }

    @PostMapping
    public ApiResponse<AppRoleDto> create(@PathVariable UUID appId,
                                          @Valid @RequestBody CreateAppRoleRequest body,
                                          @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.create(appId, body, auth.platformUserId(), auth));
    }

    @PatchMapping("/{roleId}")
    public ApiResponse<AppRoleDto> update(@PathVariable UUID appId,
                                          @PathVariable UUID roleId,
                                          @Valid @RequestBody UpdateAppRoleRequest body,
                                          @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.update(roleId, body, auth.platformUserId(), auth));
    }

    @DeleteMapping("/{roleId}")
    public ApiResponse<AppRoleDto> disable(@PathVariable UUID appId,
                                          @PathVariable UUID roleId,
                                          @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.disable(roleId, auth.platformUserId(), auth));
    }

    @PostMapping("/{roleId}/activate")
    public ApiResponse<AppRoleDto> activate(@PathVariable UUID appId,
                                            @PathVariable UUID roleId,
                                            @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(appRoleService.activate(roleId, auth.platformUserId(), auth));
    }
}
