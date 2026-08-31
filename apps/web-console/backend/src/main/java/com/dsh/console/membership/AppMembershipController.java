package com.dsh.console.membership;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.membership.dto.AppMembershipDto;
import com.dsh.console.membership.dto.UpsertMembershipRequest;
import com.dsh.console.security.AuthContext;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 应用成员治理 REST 端点(嵌在 {@code /api/applications/{appId}/memberships} 下)。
 */
@RestController
@RequestMapping("/api/applications/{appId}/memberships")
@PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
public class AppMembershipController {

    private final AppMembershipService membershipService;

    public AppMembershipController(AppMembershipService membershipService) {
        this.membershipService = membershipService;
    }

    @GetMapping
    public ApiResponse<List<AppMembershipDto>> list(@PathVariable UUID appId,
                                                    @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(membershipService.listByApp(appId, auth));
    }

    @GetMapping("/{membershipId}")
    public ApiResponse<AppMembershipDto> get(@PathVariable UUID appId,
                                             @PathVariable UUID membershipId,
                                             @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(membershipService.getById(membershipId, auth));
    }

    /**
     * 创建或更新成员(upsert 语义)。
     */
    @PostMapping
    public ApiResponse<AppMembershipDto> upsert(@PathVariable UUID appId,
                                                @Valid @RequestBody UpsertMembershipRequest body,
                                                @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(membershipService.upsert(appId, body, auth.platformUserId(), auth));
    }

    @DeleteMapping("/{membershipId}")
    public ApiResponse<AppMembershipDto> disable(@PathVariable UUID appId,
                                                  @PathVariable UUID membershipId,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(membershipService.disable(membershipId, auth.platformUserId(), auth));
    }

    @PostMapping("/{membershipId}/activate")
    public ApiResponse<AppMembershipDto> activate(@PathVariable UUID appId,
                                                  @PathVariable UUID membershipId,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(membershipService.activate(membershipId, auth.platformUserId(), auth));
    }
}
