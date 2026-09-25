package com.dsh.flowable.api;

/**
 * 办理人时效统计 DTO(分析看板办理人时效榜,user task 专属)。
 *
 * <p>数据来源:引擎 {@code ACT_HI_ACTINST} 过滤 {@code ACT_TYPE_='userTask'} 后按
 * {@code ASSIGNEE_} 分组聚合,只统计 assignee 非空且时长已知(已完成)的任务份数,
 * 按 count 倒序限 50。
 *
 * <p>{@code assignee} 为 Supabase user.id(流程身份 = JWT sub);displayName 由
 * web-console 侧 join {@code platform_users} 补齐,引擎不 join 治理库用户表
 * (保持引擎对 public schema 数据只读薄用的边界)。
 *
 * @param assignee      办理人 user.id
 * @param count         完成任务份数(多实例会签按成员计)
 * @param avgDurationMs 平均办理时长(毫秒)
 * @param maxDurationMs 最大办理时长(毫秒)
 */
public record TaskStatDto(
    String assignee,
    long count,
    Long avgDurationMs,
    Long maxDurationMs
) {
}
