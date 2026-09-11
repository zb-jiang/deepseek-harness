package com.dsh.console.app;

import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.app.dto.CreateApplicationRequest;
import com.dsh.console.app.dto.UpdateApplicationRequest;
import com.dsh.console.common.ApiResponse;
import com.dsh.console.security.AuthContext;
import com.dsh.console.skillhub.dto.SkillHubSkillDto;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 应用治理 REST 端点。
 *
 * <p>创建应用 {@code system_admin} 或 {@code app_admin};
 * 查/更新/激活/归档 {@code system_admin} 或 {@code app_admin}
 * (后者仅限自己所属应用,由 {@link ApplicationService#checkCanAccessApp} 校验)。
 */
@RestController
@RequestMapping("/api/applications")
public class ApplicationController {

    private final ApplicationService applicationService;

    public ApplicationController(ApplicationService applicationService) {
        this.applicationService = applicationService;
    }

    /**
     * 列应用。system_admin 看全部;app_admin 只看自己管理的应用。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<ApplicationDto>> list(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(required = false) String status,
        @RequestParam(defaultValue = "0") int offset,
        @RequestParam(defaultValue = "50") int limit) {
        return ApiResponse.ok(applicationService.listForUser(auth, status, offset, limit));
    }

    /**
     * 查应用详情。
     */
    @GetMapping("/{appId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ApplicationDto> get(@PathVariable UUID appId,
                                          @AuthenticationPrincipal AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return ApiResponse.ok(applicationService.getById(appId));
    }

    /**
     * 创建应用(system_admin 或 app_admin)。
     *
     * <p>app_admin 创建的应用会自动把自己加入应用管理员列表。
     */
    @PostMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ApplicationDto> create(@Valid @RequestBody CreateApplicationRequest body,
                                              @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(applicationService.create(body, auth.platformUserId(), auth.isSystemAdmin()));
    }

    /**
     * 更新应用草稿(管理员可改 name/description/icon/app_admin_user_ids/skillhub_namespace)。
     */
    @PatchMapping("/{appId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ApplicationDto> update(@PathVariable UUID appId,
                                             @Valid @RequestBody UpdateApplicationRequest body,
                                             @AuthenticationPrincipal AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return ApiResponse.ok(applicationService.update(appId, body, auth.platformUserId()));
    }

    /**
     * 列应用绑定的 SkillHub namespace 下已发布 skill(后端持 token 代理访问,浏览器不直连)。
     *
     * <p>应用未绑定 namespace 时返回 400,提示先在应用管理配置。
     */
    @GetMapping("/{appId}/skills")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<SkillHubSkillDto>> listSkills(@PathVariable UUID appId,
                                                          @AuthenticationPrincipal AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return ApiResponse.ok(applicationService.listSkillHubSkills(appId));
    }

    /**
     * 归档应用(软删除:status → archived,终态)。
     */
    @DeleteMapping("/{appId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ApplicationDto> archive(@PathVariable UUID appId,
                                              @AuthenticationPrincipal AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return ApiResponse.ok(applicationService.archive(appId, auth.platformUserId()));
    }
}
