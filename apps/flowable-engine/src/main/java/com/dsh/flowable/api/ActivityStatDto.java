package com.dsh.flowable.api;

/**
 * 节点活动统计 DTO(分析看板定义级热力图 + TOP 最慢节点表)。
 *
 * <p>数据来源:引擎 {@code ACT_HI_ACTINST} 按 {@code ACT_ID_}(BPMN 节点 id)分组聚合。
 * 口径说明:
 * <ul>
 *   <li>只统计 {@code DURATION_} 非空的行——仍在进行中的节点时长为
 *       NULL,计入会拉低均值;</li>
 *   <li>多实例节点(会签/串签)每个成员产生独立历史行,count 天然按"份数"计
 *       (会签 3 人 = count 3),符合会签分析语义;</li>
 *   <li>{@code ACT_TYPE_='sequenceFlow'} 的连线行也参与统计(连线时长极短,
 *       count 反映路径频次),前端按 activityType 区分渲染(节点染色/连线粗细)。</li>
 * </ul>
 *
 * @param activityId    BPMN 节点 id(热力图 marker 挂载键)
 * @param activityName  节点名称(取历史行最大值;同节点多行名称一致)
 * @param activityType  BPMN 活动类型(userTask/serviceTask/sequenceFlow/...)
 * @param count         执行份数(多实例按成员计)
 * @param avgDurationMs 平均时长(毫秒)
 * @param maxDurationMs 最大时长(毫秒)
 */
public record ActivityStatDto(
    String activityId,
    String activityName,
    String activityType,
    long count,
    Long avgDurationMs,
    Long maxDurationMs
) {
}
