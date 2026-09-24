package com.expense.sor.web;

import com.expense.sor.exception.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 全局异常处理:按设计文档 §10 输出结构化错误,不泄漏堆栈。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    @RawResponse
    public ResponseEntity<Map<String, Object>> handleApi(ApiException e) {
        return build(e.getHttpStatus(), e.getCode(), e.getMessage(), e.getDetails());
    }

    @ExceptionHandler({HttpMessageNotReadableException.class,
            MethodArgumentTypeMismatchException.class,
            MissingServletRequestParameterException.class,
            MaxUploadSizeExceededException.class})
    @RawResponse
    public ResponseEntity<Map<String, Object>> handleBadRequest(Exception e) {
        String msg = e instanceof MaxUploadSizeExceededException
                ? "上传文件超过 10MB 限制"
                : "请求参数格式错误";
        return build(HttpStatus.BAD_REQUEST.value(), 1400, msg, null);
    }

    /** 数据库不可用/SQL 异常:500 结构化错误,不挂死、不返回堆栈(验收项 11) */
    @ExceptionHandler(DataAccessException.class)
    @RawResponse
    public ResponseEntity<Map<String, Object>> handleDb(DataAccessException e) {
        log.error("数据库访问异常", e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR.value(), 1500, "服务内部错误:数据库访问失败", null);
    }

    @ExceptionHandler(Exception.class)
    @RawResponse
    public ResponseEntity<Map<String, Object>> handleUnexpected(Exception e) {
        log.error("未处理异常", e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR.value(), 1500, "服务内部错误", null);
    }

    private ResponseEntity<Map<String, Object>> build(int httpStatus, int code, String message,
            Map<String, Object> details) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        if (details != null && !details.isEmpty()) {
            body.put("details", details);
        }
        return ResponseEntity.status(httpStatus).body(body);
    }
}
