package com.dsh.console.user.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 禁用/锁定用户请求(可附带原因)。
 */
public record UserActionRequest(
    String reason
) {
}
