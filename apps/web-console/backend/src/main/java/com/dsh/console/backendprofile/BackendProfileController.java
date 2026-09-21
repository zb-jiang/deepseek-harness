package com.dsh.console.backendprofile;

import com.dsh.console.backendprofile.dto.BackendProfileDto;
import com.dsh.console.backendprofile.dto.BackendProfileRegisterRequest;
import com.dsh.console.backendprofile.dto.SkillRequirementDto;
import com.dsh.console.common.ApiResponse;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * DSH backend profile 注册表 REST 端点(design 2026-09-14 §5.2)。
 *
 * <p>认证边界:{@code register} 与 {@code skills} 由 backend profile 实例
 * (DSH 进程,无 Supabase 登录态)调用,走 SecurityConfig 的 permitAll 名单
 * (企业服务器内网部署前提下的服务间信任);{@code GET /} 是设计器管理员
 * 面向的下拉数据源,走 JWT + 角色注解。
 */
@RestController
@RequestMapping("/api/backend-profiles")
public class BackendProfileController {

    private final BackendProfileService backendProfileService;

    public BackendProfileController(BackendProfileService backendProfileService) {
        this.backendProfileService = backendProfileService;
    }

    /**
     * 实例自注册/心跳:按 url upsert,刷新 last_heartbeat_at。
     */
    @PostMapping("/register")
    public ApiResponse<Void> register(@Valid @RequestBody BackendProfileRegisterRequest request) {
        backendProfileService.register(request);
        return ApiResponse.ok();
    }

    /**
     * 活跃实例列表(心跳 5 分钟内),设计器 backend task 属性面板下拉数据源。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<BackendProfileDto>> listActive() {
        return ApiResponse.ok(backendProfileService.listActive());
    }

    /**
     * skill 归属聚合:指向该 URL 的已发布 DSH backend task 引用的 skill 清单
     * (带 SkillHub namespace,backend profile 按命名空间拉清单下载)。
     *
     * @param url backend profile 实例调用 URL
     */
    @GetMapping("/skills")
    public ApiResponse<List<SkillRequirementDto>> skills(@RequestParam String url) {
        return ApiResponse.ok(backendProfileService.aggregateSkillRefs(url));
    }
}
