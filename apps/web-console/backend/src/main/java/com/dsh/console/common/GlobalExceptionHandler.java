package com.dsh.console.common;

import com.dsh.console.knowledge.KbStorageException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.client.RestClientException;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * 全局异常处理。
 *
 * <p>把业务异常与框架异常统一包装为 {@link ApiResponse} 返回,前端按 code 分发处理。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** 业务异常:返回 400。 */
    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalArgument(IllegalArgumentException e) {
        log.warn("Business exception: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(ApiError.of("BUSINESS_ERROR", e.getMessage())));
    }

    /** 业务状态冲突(守卫拒绝,如流程实例未结束):返回 409。 */
    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalState(IllegalStateException e) {
        log.warn("Business conflict: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
            .body(ApiResponse.fail(ApiError.of("BUSINESS_CONFLICT", e.getMessage())));
    }

    /** 业务 not found:返回 404。 */
    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotFound(NotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(ApiResponse.fail(ApiError.of("NOT_FOUND", e.getMessage())));
    }

    /** 权限不足:返回 403。 */
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiResponse<Void>> handleAccessDenied(AccessDeniedException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
            .body(ApiResponse.fail(ApiError.of("FORBIDDEN", e.getMessage())));
    }

    /** 请求体校验失败:返回 400。 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(new ApiError("VALIDATION_ERROR",
                "请求体校验失败",
                e.getBindingResult().getFieldErrors().stream()
                    .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                    .toList())));
    }

    /** Flowable REST 调用失败:返回 502。 */
    @ExceptionHandler(RestClientException.class)
    public ResponseEntity<ApiResponse<Void>> handleRestClient(RestClientException e) {
        log.error("Flowable REST call failed", e);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
            .body(ApiResponse.fail(ApiError.of("FLOWABLE_REST_ERROR",
                "调用流程引擎失败:" + e.getMessage())));
    }

    /** Supabase Storage 调用失败(知识库上传/下载/删除):返回 502。 */
    @ExceptionHandler(KbStorageException.class)
    public ResponseEntity<ApiResponse<Void>> handleKbStorage(KbStorageException e) {
        log.error("Supabase Storage call failed", e);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
            .body(ApiResponse.fail(ApiError.of("STORAGE_ERROR",
                "访问文档存储失败:" + e.getMessage())));
    }

    /** 上传文件超过 multipart 上限:返回 400。 */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiResponse<Void>> handleMaxUpload(MaxUploadSizeExceededException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(ApiError.of("FILE_TOO_LARGE", "上传文件超过大小上限")));
    }

    /** 客户端已断开(页面刷新/跳转/请求取消):连接已断,响应体写不回去,只记一行无堆栈。 */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public void handleClientDisconnected(AsyncRequestNotUsableException e) {
        log.debug("Client disconnected before response completed: {}", e.getMessage());
    }

    /** 兜底:返回 500。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleAny(Exception e) {
        log.error("Unhandled exception", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ApiResponse.fail(ApiError.of("INTERNAL_ERROR", "服务器内部错误")));
    }

    /** 自定义 not found 业务异常。 */
    public static class NotFoundException extends RuntimeException {
        public NotFoundException(String message) {
            super(message);
        }
    }
}
