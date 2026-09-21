package com.dsh.console.user;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.security.AuthContext;
import com.dsh.console.user.dto.UpdateUserOrgUnitsRequest;
import com.dsh.console.user.dto.UpdateUserRequest;
import com.dsh.console.user.dto.UserActionRequest;
import com.dsh.console.user.dto.UserDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 平台用户治理 REST 端点。
 *
 * <p>仅 {@code system_admin} 角色可访问;由 setup guide §4 trigger 自动插入 pending_approval 记录,
 * 由本 Controller 完成审批/禁用/锁定/激活/角色更新。
 */
@RestController
@RequestMapping("/api/users")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    /**
     * 当前登录用户的治理记录(无角色要求,isAuthenticated 即可)。
     *
     * <p>覆盖类级 {@code @PreAuthorize("hasRole('SYSTEM_ADMIN')")},允许
     * pending_approval 用户查自己,前端登录后第一跳拉取此端点判断状态。
     */
    @GetMapping("/me")
    @org.springframework.security.access.prepost.PreAuthorize("isAuthenticated()")
    public ApiResponse<UserDto> me(@AuthenticationPrincipal AuthContext auth) {
        System.out.println("[UserController.me] authSubject=" + auth.authSubject() + ", platformUserId=" + auth.platformUserId());
        return ApiResponse.ok(userService.findMe(auth.authSubject()));
    }

    /**
     * 列用户(可按 status 过滤)。
     *
     * <p>system_admin 可拉全部用户;app_admin 拉取用户用于给应用添加成员。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<UserDto>> list(
        @RequestParam(required = false) String status,
        @RequestParam(defaultValue = "0") int offset,
        @RequestParam(defaultValue = "50") int limit) {
        return ApiResponse.ok(userService.list(status, offset, limit));
    }

    /**
     * 查单个用户详情。
     */
    @GetMapping("/{userId}")
    public ApiResponse<UserDto> get(@PathVariable UUID userId) {
        return ApiResponse.ok(userService.getById(userId));
    }

    /**
     * 审批用户。
     */
    @PostMapping("/{userId}/approve")
    public ApiResponse<UserDto> approve(@PathVariable UUID userId,
                                        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(userService.approve(userId, auth.platformUserId()));
    }

    /**
     * 禁用用户(可选附原因)。
     */
    @PostMapping("/{userId}/disable")
    public ApiResponse<UserDto> disable(@PathVariable UUID userId,
                                        @RequestBody(required = false) UserActionRequest body,
                                        @AuthenticationPrincipal AuthContext auth) {
        String reason = body == null ? null : body.reason();
        return ApiResponse.ok(userService.disable(userId, auth.platformUserId(), reason));
    }

    /**
     * 锁定用户(可选附原因)。
     */
    @PostMapping("/{userId}/lock")
    public ApiResponse<UserDto> lock(@PathVariable UUID userId,
                                     @RequestBody(required = false) UserActionRequest body,
                                     @AuthenticationPrincipal AuthContext auth) {
        String reason = body == null ? null : body.reason();
        return ApiResponse.ok(userService.lock(userId, auth.platformUserId(), reason));
    }

    /**
     * 激活用户(从 disabled/locked 恢复 active)。
     */
    @PostMapping("/{userId}/activate")
    public ApiResponse<UserDto> activate(@PathVariable UUID userId,
                                         @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(userService.activate(userId, auth.platformUserId()));
    }

    /**
     * 更新平台角色(覆盖写)。
     */
    @PatchMapping("/{userId}")
    public ApiResponse<UserDto> updateRoles(@PathVariable UUID userId,
                                            @Valid @RequestBody UpdateUserRequest body,
                                            @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(userService.updateRoles(userId, body, auth.platformUserId()));
    }

    /**
     * 覆盖写用户全部所属部门(body.orgUnitIds 全量;空=全部移出,负责人守卫后端校验)。
     */
    @PatchMapping("/{userId}/org-units")
    public ApiResponse<UserDto> assignOrgUnits(@PathVariable UUID userId,
                                               @RequestBody UpdateUserOrgUnitsRequest body,
                                               @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(userService.assignOrgUnits(
            userId, body.orgUnitIds(), auth.platformUserId()));
    }
}
