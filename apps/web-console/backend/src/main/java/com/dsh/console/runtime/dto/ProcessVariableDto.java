package com.dsh.console.runtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;

/**
 * 流程实例上下文变量 DTO(历史变量统一视图)。
 *
 * <p>来源引擎 {@code GET /dsh/history/variables}:运行中实例返回当前值,已结束实例
 * 返回终值(Flowable OSS 历史模型只有最终值,无逐次变更轨迹)。
 * 前端按 {@code dsh_} 前缀标注系统变量(应用隔离三变量等)。
 *
 * @param name             变量名
 * @param type             Flowable 变量类型名({@code string}/{@code long}/{@code json} 等)
 * @param value            变量值(JSON 表示)
 * @param createTime       变量创建时间(可空)
 * @param lastUpdatedTime  最后更新时间(可空)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProcessVariableDto(
    String name,
    String type,
    JsonNode value,
    OffsetDateTime createTime,
    OffsetDateTime lastUpdatedTime
) {
}
