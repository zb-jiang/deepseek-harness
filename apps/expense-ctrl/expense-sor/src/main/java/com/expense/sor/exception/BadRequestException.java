package com.expense.sor.exception;

/** 400 / code 1400 参数校验失败 */
public class BadRequestException extends ApiException {

    public BadRequestException(String message) {
        super(400, 1400, message, null);
    }
}
