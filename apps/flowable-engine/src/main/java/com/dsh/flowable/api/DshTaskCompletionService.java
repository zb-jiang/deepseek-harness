package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshContextVariable;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshExtensionResolver;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flowable.engine.TaskService;
import org.flowable.task.api.Task;
import org.springframework.stereotype.Service;

/**
 * userTask 提交端点的变量写入(design 2026-09-01 §6):员工端已在提交对话框完成
 * JSON → 流程变量的映射,引擎端接收 variables Map,按声明类型转换后写入。
 *
 * <p>写入规则按声明类型分派:
 * <ul>
 *   <li>array 类型:读现有 List → append → 写回——多实例(会签/串签)下每个实例的
 *       提交都追加元素,即输出聚合;非多实例任务同样适用(单元素列表)。</li>
 *   <li>object 及标量:直接覆写——多实例单人(完成条件 nrOfCompletedInstances ≥ 1)
 *       触发后其余实例被引擎自动删除,首个提交值自然生效。</li>
 * </ul>
 *
 * <p>值按声明类型转换:integer→Long、float→Double、boolean→Boolean、object→Map、
 * array 元素(单个值或 List)追加;date(yyyy-MM-dd)与 datetime(yyyy-MM-dd'T'HH:mm:ss)
 * 按严格格式校验后以字符串存储(字典序即时间序)。未声明变量拒绝写入、系统注入变量
 * (source=system)拒绝覆盖(fail loud)。
 *
 * <p>并发提交同一 array target 时读-改-写窗口由 Flowable 乐观锁检测,
 * 冲突请求报错由客户端重试。
 */
@Service
public class DshTaskCompletionService {

    /** date 严格格式(设计决策 #8:字典序即时间序)。 */
    private static final DateTimeFormatter DATE_FORMAT =
        DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT);

    /** datetime 严格格式(ISO-8601,不带时区与纳秒)。 */
    private static final DateTimeFormatter DATETIME_FORMAT =
        DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss").withResolverStyle(ResolverStyle.STRICT);

    private final TaskService taskService;
    private final DshExtensionResolver resolver;

    public DshTaskCompletionService(TaskService taskService, DshExtensionResolver resolver) {
        this.taskService = taskService;
        this.resolver = resolver;
    }

    /**
     * 接收员工端已经映射好的 variables Map,按声明类型转换后写入流程变量并 complete 任务。
     *
     * @throws IllegalArgumentException 变量未声明,或提交值与声明类型不符
     *                                  (或 date/datetime 格式非法)
     */
    public void completeWithVariables(Task task, Map<String, Object> variables) {
        List<DshContextVariable> declarations =
            resolver.resolveContextVariables(task.getProcessDefinitionId());
        Map<String, Object> vars = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : variables.entrySet()) {
            String name = entry.getKey();
            Object value = entry.getValue();
            DshContextVariable decl = findDeclaration(declarations, name);
            if (decl == null) {
                throw new IllegalArgumentException("变量 " + name + " 未在流程上下文声明中定义");
            }
            if (DshContextVariable.SYSTEM_SOURCE.equals(decl.source())) {
                throw new IllegalArgumentException(
                    "变量 " + name + " 为系统注入变量(source=system,启动时按登录人注入),不允许任务提交覆盖");
            }
            Object converted = convertByType(value, decl);
            if ("array".equals(decl.type())) {
                Object existing = readExisting(task.getId(), vars, name);
                List<Object> list = existing instanceof List<?> l ? new ArrayList<>(l) : new ArrayList<>();
                if (converted instanceof List<?> newList) {
                    list.addAll(newList);
                } else {
                    list.add(converted);
                }
                vars.put(name, list);
            } else {
                vars.put(name, converted);
            }
        }
        taskService.complete(task.getId(), vars);
    }

    /**
     * 旧契约:员工提交 JSON,后端按节点 outputMappings 执行映射。
     *
     * @deprecated 2026-09-03 提交契约 moved 到员工端,后端改接收 variables Map,
     *             使用 {@link #completeWithVariables(Task, Map)}。
     */
    @Deprecated(forRemoval = true)
    public void complete(Task task, Map<String, Object> output) {
        DshExtensionProperties props = resolver.resolveTaskProperties(
            task.getProcessDefinitionId(), task.getTaskDefinitionKey());
        List<DshExtensionProperties.OutputMapping> mappings =
            props == null ? List.of() : props.outputMappings();
        if (mappings == null || mappings.isEmpty()) {
            taskService.complete(task.getId());
            return;
        }
        List<DshContextVariable> declarations =
            resolver.resolveContextVariables(task.getProcessDefinitionId());
        Map<String, Object> vars = new LinkedHashMap<>();
        for (DshExtensionProperties.OutputMapping mapping : mappings) {
            applyMapping(task.getId(), output, mapping, declarations, vars);
        }
        taskService.complete(task.getId(), vars);
    }

    /**
     * 执行单条映射:source 点路径取值 → 按 target 声明类型转换 → 按 target 形态写入 vars。
     * source 提取结果为 null(字段缺失)时跳过该条映射。
     */
    private void applyMapping(String taskId,
                               Map<String, Object> output,
                               DshExtensionProperties.OutputMapping mapping,
                               List<DshContextVariable> declarations,
                               Map<String, Object> vars) {
        Object value = extractSource(output, mapping.source());
        if (value == null) {
            return;
        }
        String target = mapping.target();
        String root = rootSegment(target);
        DshContextVariable decl = declarations.stream()
            .filter(d -> root.equals(d.name()))
            .findFirst().orElse(null);
        Object converted = convertByType(value, decl);

        String rest = target.contains(".")
            ? target.substring(target.indexOf('.') + 1) : null;
        if (rest == null && decl != null && "array".equals(decl.type())) {
            // array 根路径:读现有 List → append → 写回(多实例输出聚合)
            Object existing = readExisting(taskId, vars, root);
            List<Object> list = existing instanceof List<?> l ? new ArrayList<>(l) : new ArrayList<>();
            list.add(converted);
            vars.put(root, list);
        } else if (rest == null) {
            vars.put(root, converted);
        } else {
            // .field 深入路径:读现有值(应为 Map),沿路径复制脊柱后写叶子
            Object existing = readExisting(taskId, vars, root);
            if (existing != null && !(existing instanceof Map)) {
                throw new IllegalArgumentException(
                    "映射 target=" + target + " 的根变量已有非 object 值,无法深入字段路径");
            }
            Map<String, Object> map = copyMap((Map<?, ?>) existing);
            setPath(map, rest, converted);
            vars.put(root, map);
        }
    }

    /** source 点路径取值;source 空/未配置取整体提交 JSON,路径中途断开返回 null。 */
    private Object extractSource(Map<String, Object> output, String source) {
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
     * 按声明类型转换提交值;decl 为 null(未声明)原样通过。
     *
     * @throws IllegalArgumentException 类型不符或 date/datetime 格式非法
     */
    private Object convertByType(Object value, DshContextVariable decl) {
        if (decl == null) {
            return value;
        }
        String name = decl.name();
        return switch (decl.type() == null ? "" : decl.type()) {
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
            case "array" -> {
                // 员工端可能提交单个元素(append)或 List(addAll),后端统一追加处理。
                yield value;
            }
            default -> value; // string 及未知类型原样
        };
    }

    private Long parseLong(String name, Object value) {
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("变量 " + name + " 声明为 integer,提交值不是整数: " + value);
        }
    }

    private Double parseDouble(String name, Object value) {
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("变量 " + name + " 声明为 float,提交值不是数字: " + value);
        }
    }

    private Boolean parseBoolean(String name, Object value) {
        if ("true".equals(value) || Boolean.TRUE.equals(value)) {
            return Boolean.TRUE;
        }
        if ("false".equals(value) || Boolean.FALSE.equals(value)) {
            return Boolean.FALSE;
        }
        throw new IllegalArgumentException("变量 " + name + " 声明为 boolean,提交值不是布尔: " + value);
    }

    /** date/datetime 按严格格式校验,通过后以原字符串返回(设计决策 #8)。 */
    private String validateDateFormat(String name, Object value, DateTimeFormatter format) {
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

    /** 读 target 根变量的现有值:同一提交内多条映射命中同一根时先读前条写入结果。 */
    private Object readExisting(String taskId, Map<String, Object> vars, String root) {
        if (vars.containsKey(root)) {
            return vars.get(root);
        }
        return taskService.getVariable(taskId, root);
    }

    /** 沿点路径写叶子,路径脊柱逐层浅拷贝,不改引擎现有对象。 */
    private void setPath(Map<String, Object> map, String path, Object value) {
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

    @SuppressWarnings("unchecked")
    private Map<String, Object> copyMap(Map<?, ?> source) {
        return source == null ? new LinkedHashMap<>() : new LinkedHashMap<>((Map<String, Object>) source);
    }

    private static String rootSegment(String target) {
        int dot = target.indexOf('.');
        return dot < 0 ? target : target.substring(0, dot);
    }

    private static DshContextVariable findDeclaration(
        List<DshContextVariable> declarations, String name) {
        return declarations.stream()
            .filter(d -> name.equals(d.name()))
            .findFirst()
            .orElse(null);
    }
}
