package com.expense.sor.service;

import com.expense.sor.exception.BadRequestException;
import com.expense.sor.exception.ConflictException;
import com.expense.sor.exception.NotFoundException;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 通用校验工具:所有 400/409 类校验集中在此,保证错误码与消息风格一致(设计文档 §7/§10)。
 */
public final class Validators {

    private Validators() {
    }

    /**
     * 合法状态集合(含过程态):
     * opened(提交后初始态) → ongoing(任一人审批过) → approved(最后审批节点通过,正式批准) → paid;
     * 任一审批拒绝 → rejected;ongoing/approved 阶段可撤回 → cancelled。
     */
    public static final Set<String> ALL_STATES =
            Set.of("opened", "ongoing", "approved", "rejected", "paid", "cancelled");

    /** 显式迁移合法性(设计文档 §6 状态机);ongoing→ongoing 的幂等重放不进矩阵,由调用方短路 */
    public static final Map<String, Set<String>> ALLOWED_TRANSITIONS = Map.of(
            "opened", Set.of("ongoing", "approved", "rejected"),
            "ongoing", Set.of("approved", "rejected", "cancelled"),
            "approved", Set.of("paid", "cancelled"));

    public static String requireNonBlank(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new BadRequestException(field + " 不能为空");
        }
        return value.trim();
    }

    /** 金额:十进制字符串,最多两位小数,必须 > 0(设计文档 §7 统一约定) */
    public static BigDecimal requirePositiveAmount(String value, String field) {
        requireNonBlank(value, field);
        if (!value.matches("\\d{1,10}(\\.\\d{1,2})?")) {
            throw new BadRequestException(field + " 格式非法,应为最多两位小数的正数十进制字符串,如 \"1500.00\"");
        }
        BigDecimal amount = new BigDecimal(value);
        if (amount.signum() <= 0) {
            throw new BadRequestException(field + " 必须大于 0");
        }
        return amount.setScale(2);
    }

    public static LocalDate requireDate(String value, String field) {
        requireNonBlank(value, field);
        try {
            return LocalDate.parse(value);
        } catch (DateTimeParseException e) {
            throw new BadRequestException(field + " 格式非法,应为 yyyy-MM-dd");
        }
    }

    public static UUID requireUuid(String value, String field) {
        requireNonBlank(value, field);
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(field + " 不是合法的 UUID");
        }
    }

    public static UUID parseUuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static void requireState(String status, String field) {
        requireNonBlank(status, field);
        if (!ALL_STATES.contains(status)) {
            throw new BadRequestException(field + " 非法,可选值: " + String.join("/", ALL_STATES));
        }
    }

    /** 非法迁移 fail loud(设计文档 §6 规则 2),details 携带 current */
    public static ConflictException illegalTransition(String current, String detail) {
        return new ConflictException("ILLEGAL_STATE_TRANSITION", Map.of("current", current, "reason", detail));
    }

    public static NotFoundException notFound(String what) {
        return new NotFoundException(what + "不存在");
    }
}
