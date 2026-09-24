package com.expense.sor.exception;

import java.util.Map;

/**
 * 业务异常基类:携带 HTTP 状态码、业务错误码与可选 details(设计文档 §10 错误码汇总)。
 */
public class ApiException extends RuntimeException {

    private final int httpStatus;
    private final int code;
    private final Map<String, Object> details;

    public ApiException(int httpStatus, int code, String message, Map<String, Object> details) {
        super(message);
        this.httpStatus = httpStatus;
        this.code = code;
        this.details = details;
    }

    public int getHttpStatus() {
        return httpStatus;
    }

    public int getCode() {
        return code;
    }

    public Map<String, Object> getDetails() {
        return details;
    }
}
