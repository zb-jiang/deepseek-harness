package com.dsh.console.llm;

/**
 * LLM 模块业务异常。
 * 业务含义:携带机器可读错误码(如 LLM_QUOTA_EXHAUSTED),由 LlmExceptionHandler 翻译成统一响应。
 */
public class LlmException extends RuntimeException {

    private final String code;
    private final int httpStatus;

    public LlmException(String code, String message) {
        this(code, message, 400);
    }

    public LlmException(String code, String message, int httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public String code() {
        return code;
    }

    public int httpStatus() {
        return httpStatus;
    }
}
