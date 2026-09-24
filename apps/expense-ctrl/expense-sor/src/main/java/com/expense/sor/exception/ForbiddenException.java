package com.expense.sor.exception;

/** 403 / code 1403 非本人操作 / approverId 与 JWT 不符 */
public class ForbiddenException extends ApiException {

    public ForbiddenException(String message) {
        super(403, 1403, message, null);
    }
}
