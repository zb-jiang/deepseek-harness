package com.dsh.console.common;

/**
 * API 错误信息。
 *
 * @param code      错误码(机器可读,如 USER_NOT_FOUND / VALIDATION_ERROR / FLOWABLE_REST_ERROR)
 * @param message   错误描述(人可读,用于前端展示)
 * @param detail    错误详情(可选,如字段级校验错误列表)
 */
public record ApiError(
    String code,
    String message,
    Object detail
) {
    /** 简单错误,无 detail。 */
    public static ApiError of(String code, String message) {
        return new ApiError(code, message, null);
    }
}
