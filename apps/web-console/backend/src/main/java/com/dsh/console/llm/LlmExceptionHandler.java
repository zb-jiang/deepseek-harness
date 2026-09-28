package com.dsh.console.llm;

import com.dsh.console.common.ApiError;
import com.dsh.console.common.ApiResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * LLM 模块异常翻译。
 * 业务含义:把 LlmException 的错误码原样透出(如 LLM_QUOTA_EXHAUSTED),员工端据此展示对应提示。
 * 必须优先于 GlobalExceptionHandler:后者的 Exception.class 兜底匹配一切异常,无 @Order 时
 * advice 遍历顺序不稳定,LlmException 可能被全局兜底抢走而丢失设计的状态码(如 502)。
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice
public class LlmExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(LlmExceptionHandler.class);

    @ExceptionHandler(LlmException.class)
    public ResponseEntity<ApiResponse<Void>> handleLlm(LlmException e) {
        // 业务错误也落日志:网关类错误(502/503)在控制台不可见会导致运维误判为「没报错」
        log.warn("LLM business error [{}]: {}", e.code(), e.getMessage());
        return ResponseEntity.status(e.httpStatus())
            .body(ApiResponse.fail(ApiError.of(e.code(), e.getMessage())));
    }
}
