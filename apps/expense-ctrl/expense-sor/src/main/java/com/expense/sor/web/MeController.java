package com.expense.sor.web;

import com.expense.sor.exception.ForbiddenException;
import com.expense.sor.service.PlatformUserDirectory;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 当前登录用户信息(Web UI 新增,2026-09-24,仅 JWT):
 * GET /api/me -> {sub, email, displayName}
 * - sub:JWT sub(Supabase 用户 UUID),建单/审批/支付的 actor id 以此为准;
 * - email:JWT email claim(Supabase 签发的 token 通常携带);
 * - displayName:platform_users 表按 auth_subject 匹配出的 display_name,
 *   查不到时为 null,前端回退 email/sub。
 */
@RestController
@RequestMapping("/api/me")
public class MeController {

    private final PlatformUserDirectory directory;

    public MeController(PlatformUserDirectory directory) {
        this.directory = directory;
    }

    @GetMapping
    public Map<String, Object> me() {
        String sub = CurrentUser.userId();
        if (CurrentUser.isServiceCall() || sub == null) {
            throw new ForbiddenException("该端点仅接受用户 JWT 认证");
        }
        String email = null;
        if (org.springframework.security.core.context.SecurityContextHolder.getContext()
                .getAuthentication() != null
                && org.springframework.security.core.context.SecurityContextHolder.getContext()
                        .getAuthentication().getPrincipal() instanceof Jwt jwt) {
            Object claim = jwt.getClaims().get("email");
            email = claim == null ? null : claim.toString();
        }
        String displayName = directory.findDisplayName(sub).orElse(null);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sub", sub);
        body.put("email", email);
        body.put("displayName", displayName);
        return body;
    }
}
