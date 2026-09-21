package com.dsh.flowable.listener;

import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 输出映射的 source 取值 / 类型转换 / target 点路径写入公共逻辑
 * (design 2026-09-01 §6;公共化供 userTask 提交端点与 DSH backend task
 * delegate 复用,design 2026-09-14 §6.3)。
 *
 * <p>值按声明类型转换:integer→Long、float→Double、boolean→Boolean、
 * object→Map、array 原样(写入策略由调用方决定:userTask 提交端点 append 聚合,
 * backend delegate 整体覆盖);date(yyyy-MM-dd)与 datetime
 * (yyyy-MM-dd'T'HH:mm:ss)按严格格式校验后以字符串存储(字典序即时间序)。
 */
public final class DshVariableMappingSupport {

    /** date 严格格式(设计决策 #8:字典序即时间序)。 */
    private static final DateTimeFormatter DATE_FORMAT =
        DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT);

    /** datetime 严格格式(ISO-8601,不带时区与纳秒)。 */
    private static final DateTimeFormatter DATETIME_FORMAT =
        DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss").withResolverStyle(ResolverStyle.STRICT);

    private DshVariableMappingSupport() {
    }

    /**
     * source 点路径取值;source 空/未配置取整体输出 JSON,路径中途断开返回 null
     * (调用方按「字段缺失跳过该条映射」处理)。
     */
    public static Object extractSource(Map<String, Object> output, String source) {
        if (source == null || source.isBlank()) {
            return output;
        }
        Object value = output;
        for (String segment : source.split("\\.")) {
            if (!(value instanceof Map<?, ?> map)) {
                return null;
            }
            value = map.get(segment);
        }
        return value;
    }

    /**
     * 按声明类型转换提交值;decl 为 null(未声明)原样通过——未声明守卫由调用方负责
     * (userTask 提交端点与 backend delegate 都 fail loud 拒绝)。
     *
     * @throws IllegalArgumentException 类型不符或 date/datetime 格式非法
     */
    public static Object convertByType(Object value, DshContextVariable decl) {
        if (decl == null) {
            return value;
        }
        return convert(value, decl.name(), decl.type());
    }

    /**
     * 按 object 字段声明的类型转换提交值(深路径映射的叶子值:值形态对应叶子字段,
     * 不再按根变量的 object/array 类型校验)。
     *
     * @throws IllegalArgumentException 类型不符或 date/datetime 格式非法
     */
    public static Object convertByType(Object value, DshContextVariable.Field field) {
        if (field == null) {
            return value;
        }
        return convert(value, field.name(), field.type());
    }

    private static Object convert(Object value, String name, String type) {
        return switch (type == null ? "" : type) {
            case "integer" -> value instanceof Number n ? n.longValue() : parseLong(name, value);
            case "float" -> value instanceof Number n ? n.doubleValue() : parseDouble(name, value);
            case "boolean" -> value instanceof Boolean b ? b : parseBoolean(name, value);
            case "date" -> validateDateFormat(name, value, DATE_FORMAT);
            case "datetime" -> validateDateFormat(name, value, DATETIME_FORMAT);
            case "object" -> {
                if (value instanceof Map) {
                    yield value;
                }
                throw new IllegalArgumentException("变量 " + name + " 声明为 object,提交值不是 JSON 对象");
            }
            default -> value; // string / array 及未知类型原样
        };
    }

    /**
     * 沿点路径在根声明的字段清单中解析叶子字段声明;任一段未声明或途经非 object
     * 字段返回 null(调用方 fail loud:设计器下拉只提供已声明路径)。
     */
    public static DshContextVariable.Field resolveLeafField(DshContextVariable rootDecl, String dotPath) {
        List<DshContextVariable.Field> fields = rootDecl.fields();
        DshContextVariable.Field current = null;
        for (String segment : dotPath.split("\\.")) {
            if (fields == null) {
                return null;
            }
            current = fields.stream()
                .filter(f -> segment.equals(f.name()))
                .findFirst().orElse(null);
            if (current == null) {
                return null;
            }
            fields = current.fields();
        }
        return current;
    }

    /** target 的根变量名(首个 {@code .} 之前的段)。 */
    public static String rootSegment(String target) {
        int dot = target.indexOf('.');
        return dot < 0 ? target : target.substring(0, dot);
    }

    /**
     * 沿点路径写叶子,路径脊柱逐层浅拷贝,不改引擎现有对象。
     */
    public static void setPath(Map<String, Object> map, String path, Object value) {
        String[] segments = path.split("\\.");
        Map<String, Object> current = map;
        for (int i = 0; i < segments.length - 1; i++) {
            Object next = current.get(segments[i]);
            Map<String, Object> copy = next instanceof Map<?, ?> m ? copyMap(m) : new LinkedHashMap<>();
            current.put(segments[i], copy);
            current = copy;
        }
        current.put(segments[segments.length - 1], value);
    }

    /** 浅拷贝;null 返回空 Map(路径脊柱的缺失层按新对象建)。 */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> copyMap(Map<?, ?> source) {
        return source == null ? new LinkedHashMap<>() : new LinkedHashMap<>((Map<String, Object>) source);
    }

    private static Long parseLong(String name, Object value) {
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("变量 " + name + " 声明为 integer,提交值不是整数: " + value);
        }
    }

    private static Double parseDouble(String name, Object value) {
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("变量 " + name + " 声明为 float,提交值不是数字: " + value);
        }
    }

    private static Boolean parseBoolean(String name, Object value) {
        if ("true".equals(value) || Boolean.TRUE.equals(value)) {
            return Boolean.TRUE;
        }
        if ("false".equals(value) || Boolean.FALSE.equals(value)) {
            return Boolean.FALSE;
        }
        throw new IllegalArgumentException("变量 " + name + " 声明为 boolean,提交值不是布尔: " + value);
    }

    /** date/datetime 按严格格式校验,通过后以原字符串返回(设计决策 #8)。 */
    private static String validateDateFormat(String name, Object value, DateTimeFormatter format) {
        if (!(value instanceof String s)) {
            throw new IllegalArgumentException("变量 " + name + " 声明为 date/datetime,提交值必须是字符串: " + value);
        }
        try {
            format.parse(s);
            return s;
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException(
                "变量 " + name + " 的值 " + s + " 不符合声明的日期格式(应为 "
                    + (format == DATE_FORMAT ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss") + ")");
        }
    }
}
