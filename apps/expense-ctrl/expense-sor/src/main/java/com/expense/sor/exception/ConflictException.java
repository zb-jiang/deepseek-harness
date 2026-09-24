package com.expense.sor.exception;

import java.util.Map;

/**
 * 409 / code 1409 状态迁移非法 / 打款记录已存在 / processInstanceId 冲突。
 * 非法迁移时 details 携带 current/expected(设计文档 §7.4)。
 */
public class ConflictException extends ApiException {

    public ConflictException(String message) {
        this(message, null);
    }

    public ConflictException(String message, Map<String, Object> details) {
        super(409, 1409, message, details);
    }
}
