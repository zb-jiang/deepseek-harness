package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * DSH 历史变量 DTO,供历史/审计端点返回。
 *
 * <p>对应 SPEC §10.1 审计接口要求:查看实例的流程上下文变量最终值。运行中实例的
 * 历史变量行随引擎实时更新,因此本端点对运行中和已结束实例返回的都是"当前最新值"
 * (运行中=当前值,已结束=终值);逐次变更轨迹不在 Flowable OSS 历史模型内。
 *
 * <p>数据来源:Flowable {@code ACT_HI_VARINST}(HistoryLevel.FULL/AUDIT 均记录)。
 * {@code value} 统一转 JsonNode:标量原样,JSON 字符串解析为对象,不可序列化的
 * Serializable 值降级为 toString 文本,保证审计可读。
 *
 * @param id                 历史变量实例 id
 * @param processInstanceId  所属实例 id
 * @param variableName       变量名
 * @param variableTypeName   变量类型({@code string}/{@code long}/{@code json} 等 Flowable 类型名)
 * @param value              变量值(JSON 表示)
 * @param createTime         变量创建时间(ISO 8601)
 * @param lastUpdatedTime    最后更新时间(ISO 8601)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HistoricVariableDto(
    String id,
    String processInstanceId,
    String variableName,
    String variableTypeName,
    JsonNode value,
    String createTime,
    String lastUpdatedTime
) {
}
