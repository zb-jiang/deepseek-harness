package com.dsh.flowable.listener;

import java.util.List;

/**
 * 流程级上下文变量声明(process 的 {@code dsh:contextVariables} 解析结果,design 2026-09-01 §4)。
 *
 * <p>变量四要素 + array 的 itemType + object/array 的字段清单;来源 {@code source}
 * 为 {@code "start-param"} 时表示可由启动参数传入,其余来源(initial / 节点产出)
 * 由 web-console 校验器推导,引擎只关心类型转换(提交端点按 type 反序列化)。
 *
 * @param name         变量名,流程内唯一
 * @param type         八种:string / integer / float / boolean / date / datetime / object / array
 * @param description  设计时说明文本
 * @param initialValue 初始值常量(严格格式字符串;与 start-param 可共存兜底);nullable
 * @param itemType     array 的元素类型;仅 type=array 时有意义;nullable
 * @param source       来源标记;"start-param" = 启动传入;nullable
 * @param fields       object 字段清单(array 且 itemType=object 时为元素字段清单);nullable
 */
public record DshContextVariable(
    String name,
    String type,
    String description,
    String initialValue,
    String itemType,
    String source,
    List<Field> fields
) {

    /**
     * object 字段清单条目,支持嵌套(field 类型为 object 时可再挂 field)。
     *
     * @param name        字段名
     * @param type        字段类型(同变量八种)
     * @param description 字段说明;nullable
     * @param fields      嵌套字段清单(仅 type=object);nullable
     */
    public record Field(String name, String type, String description, List<Field> fields) {}
}
