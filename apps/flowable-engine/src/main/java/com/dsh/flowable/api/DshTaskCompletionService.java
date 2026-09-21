package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshBpmnParseHandler;
import com.dsh.flowable.listener.DshContextVariable;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.dsh.flowable.listener.DshVariableMappingSupport;
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
            Object converted = DshVariableMappingSupport.convertByType(value, decl);
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
        // 会签计票(design 2026-09-15 §4.5):放在声明校验之后、complete 之前——
        // 校验失败抛出时尚未计数,重提不会重复累计;complete 内部求值完成条件能读到计数
        applyVotingAggregation(task, variables);
        taskService.complete(task.getId(), vars);
    }

    /**
     * 会签计票聚合(design 2026-09-15 §4.5):节点配了 {@code dsh:votingRule} 时,
     * 读本次提交的表决变量值并累加计票流程变量:
     * <ul>
     *   <li>归一化值(去空白字符串化)等于 passValue → {@code dsh_passCount_<taskId>} +1;</li>
     *   <li>非空且不等于 passValue → {@code dsh_rejectCount_<taskId>} +1;</li>
     *   <li>值缺失(员工在提交对话框清空了该映射)→ 不计票,不阻断提交。</li>
     * </ul>
     * 计数变量为运行时注入(不在上下文声明面),首次从 0 起算;完成条件由
     * {@link com.dsh.flowable.listener.DshBpmnParseHandler} 部署时按 votingRule 自动生成。
     */
    private void applyVotingAggregation(Task task, Map<String, Object> variables) {
        DshExtensionProperties props = resolver.resolveTaskProperties(
            task.getProcessDefinitionId(), task.getTaskDefinitionKey());
        if (props == null || props.votingRule() == null) {
            return;
        }
        DshExtensionProperties.VotingRule rule = props.votingRule();
        Object value = variables.get(rule.variable());
        if (value == null) {
            return;
        }
        String normalized = String.valueOf(value).trim();
        boolean isPass = normalized.equals(rule.passValue().trim());
        String countVar = (isPass
            ? DshBpmnParseHandler.PASS_COUNT_VARIABLE_PREFIX
            : DshBpmnParseHandler.REJECT_COUNT_VARIABLE_PREFIX)
            + task.getTaskDefinitionKey();
        Object current = taskService.getVariable(task.getId(), countVar);
        long next = (current instanceof Number n ? n.longValue() : 0) + 1;
        taskService.setVariable(task.getId(), countVar, next);
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
        Object value = DshVariableMappingSupport.extractSource(output, mapping.source());
        if (value == null) {
            return;
        }
        String target = mapping.target();
        String root = DshVariableMappingSupport.rootSegment(target);
        DshContextVariable decl = declarations.stream()
            .filter(d -> root.equals(d.name()))
            .findFirst().orElse(null);
        Object converted = DshVariableMappingSupport.convertByType(value, decl);

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
            Map<String, Object> map = DshVariableMappingSupport.copyMap((Map<?, ?>) existing);
            DshVariableMappingSupport.setPath(map, rest, converted);
            vars.put(root, map);
        }
    }

    /** 读 target 根变量的现有值:同一提交内多条映射命中同一根时先读前条写入结果。 */
    private Object readExisting(String taskId, Map<String, Object> vars, String root) {
        if (vars.containsKey(root)) {
            return vars.get(root);
        }
        return taskService.getVariable(taskId, root);
    }

    private static DshContextVariable findDeclaration(
        List<DshContextVariable> declarations, String name) {
        return declarations.stream()
            .filter(d -> name.equals(d.name()))
            .findFirst()
            .orElse(null);
    }
}
