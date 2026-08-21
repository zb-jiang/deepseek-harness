package com.dsh.flowable.delegate;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * DSH web profile 执行自动节点后返回的响应体。
 *
 * <p>由 {@link DshServiceTaskDelegate} 解析,把 {@link #output} 写回 execution 变量
 * {@code dsh_auto_output} 供下游节点消费;{@link #notes} 作为附加上下文写入
 * {@code dsh_auto_notes}(对应 SPEC §7.8 自然语言说明机制,自动节点同样适用)。
 *
 * @param output   自动节点的结构化产出(JSON 对象);供下游节点按 inputSchema 消费
 * @param notes    自然语言说明,可选;下游参考用
 * @param success  执行是否成功;false 时 {@link DshServiceTaskDelegate} 抛异常触发 §9.3 失败处理
 * @param error    执行失败时的可读错误说明(success=false 时必填)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AutoNodeResponse(
    Map<String, Object> output,
    String notes,
    boolean success,
    String error
) {
}
