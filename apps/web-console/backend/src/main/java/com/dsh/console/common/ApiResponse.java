package com.dsh.console.common;

/**
 * 统一 API 响应包装。
 *
 * <p>所有 Controller 返回 {@code ApiResponse<T>},前端按 success 字段分发处理。
 *
 * @param success  是否成功
 * @param data     成功时的数据(失败为 null)
 * @param error    失败时的错误信息(成功为 null)
 */
public record ApiResponse<T>(
    boolean success,
    T data,
    ApiError error
) {
    /** 成功响应快捷构造。 */
    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, data, null);
    }

    /** 成功响应无数据。 */
    public static <T> ApiResponse<T> ok() {
        return new ApiResponse<>(true, null, null);
    }

    /** 失败响应快捷构造。 */
    public static <T> ApiResponse<T> fail(ApiError error) {
        return new ApiResponse<>(false, null, error);
    }
}
