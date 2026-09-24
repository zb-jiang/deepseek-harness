package com.expense.sor.web;

import com.expense.sor.config.ServiceKeyAuthFilter;
import com.expense.sor.exception.ForbiddenException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 当前请求身份工具(设计文档 §3/§4):
 * - JWT 调用:userId() 返回 JWT sub
 * - 服务密钥调用:isServiceCall() 为 true,userId() 返回 null,
 *   approverId/paidBy 等以请求体携带值为准,不与 JWT 比对。
 */
public final class CurrentUser {

    private CurrentUser() {
    }

    /** 返回当前 JWT 的 sub;服务密钥调用返回 null */
    public static String userId() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof Jwt jwt) {
            return jwt.getSubject();
        }
        return null;
    }

    /** 是否为 X-Service-Key 服务间调用 */
    public static boolean isServiceCall() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
            return Boolean.TRUE.equals(attrs.getRequest().getAttribute(ServiceKeyAuthFilter.SERVICE_CALL_ATTR));
        }
        return false;
    }

    /**
     * 取操作人 id:JWT 调用时为 sub;服务密钥调用时使用请求体携带值。
     * 若 JWT 调用时请求体携带的 id 与 sub 不一致,抛 403(设计文档 §7.5/§7.6)。
     */
    public static String resolveActorId(String bodyActorId, String fieldName) {
        String sub = userId();
        if (sub != null) {
            if (bodyActorId == null || bodyActorId.isBlank() || !sub.equals(bodyActorId)) {
                throw new ForbiddenException(fieldName + " 与当前用户身份不符");
            }
            return sub;
        }
        if (isServiceCall()) {
            if (bodyActorId == null || bodyActorId.isBlank()) {
                throw new com.expense.sor.exception.BadRequestException(fieldName + " 不能为空");
            }
            return bodyActorId;
        }
        throw new ForbiddenException("无有效身份");
    }
}
