package com.expense.sor.exception;

/** 404 / code 1404 单据或附件不存在 */
public class NotFoundException extends ApiException {

    public NotFoundException(String message) {
        super(404, 1404, message, null);
    }
}
