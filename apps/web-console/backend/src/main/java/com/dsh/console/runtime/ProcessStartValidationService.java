package com.dsh.console.runtime;

import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.BpmnContextParser;
import com.dsh.console.workflow.BpmnContextParser.ContextVariable;
import com.dsh.console.runtime.dto.StartFormVariableDto;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * 流程实例启动校验与变量构造(design 2026-09-01 §4 严格声明制)。
 *
 * <p>按已部署 BPMN 的 {@code dsh:contextVariables} 声明执行:
 * <ul>
 *   <li>拒绝未声明变量、声明了但未标记 start-param 的变量(fail loud);</li>
 *   <li>传入值按声明类型反序列化:integer→Long、float→Double、boolean→Boolean、
 *       object→Map、array→List;date(yyyy-MM-dd)/datetime(ISO-8601)按严格格式校验后
 *       以字符串存储(字典序即时间序);</li>
 *   <li>未传入的 start-param / 声明变量按 initial 兜底注入;</li>
 *   <li>{@code source="system"} 声明(initiator)按登录人自动注入,调用方传入同名变量拒绝。</li>
 * </ul>
 */
@Service
public class ProcessStartValidationService {

    private static final String START_PARAM = "start-param";

    private final FlowableRestClient flowableRestClient;
    private final ObjectMapper objectMapper;

    public ProcessStartValidationService(FlowableRestClient flowableRestClient,
                                         ObjectMapper objectMapper) {
        this.flowableRestClient = flowableRestClient;
        this.objectMapper = objectMapper;
    }

    /**
     * 取已部署 BPMN 的上下文声明(启动表单生成与启动校验共用)。
     */
    public List<ContextVariable> loadDeclarations(String procdefId) {
        return loadStartContext(procdefId).declarations();
    }

    /**
     * 启动上下文(design 2026-09-19 §5.1):上下文声明 + 流程是否含同行政线节点。
     *
     * @param declarations            已部署 BPMN 的上下文声明(启动表单/严格声明制)
     * @param requiresApplicantOrgUnit 流程含虚拟角色或 sameLine 实体角色节点
     *                                 (组织维度审批路由要求申请人已分配部门)
     */
    public record StartContext(List<ContextVariable> declarations, boolean requiresApplicantOrgUnit) {
    }

    /**
     * 一次引擎 XML 拉取同时解析上下文声明与审批规则(启动链路避免重复拉取)。
     */
    public StartContext loadStartContext(String procdefId) {
        String bpmnXml = flowableRestClient.getProcessDefinitionBpmnXml(procdefId);
        try {
            org.w3c.dom.Document doc = BpmnContextParser.parseXml(bpmnXml);
            boolean requires = BpmnContextParser.parseAssignmentRules(doc).stream()
                .anyMatch(BpmnContextParser.AssignmentRuleInfo::requiresApplicantOrgUnit);
            return new StartContext(BpmnContextParser.parseContextVariables(doc), requires);
        } catch (Exception e) {
            throw new IllegalStateException("解析已部署 BPMN 失败: " + e.getMessage(), e);
        }
    }

    /**
     * 解析发起身份部门(design 2026-09-19 §5.1 发起身份选择,决策 10)。
     *
     * <p>申请人的部门归属是多对多(org_unit_members),锚点在发起时动态确定:
     * <ul>
     *   <li>0 个部门:流程含同行政线节点 → 拒绝(§5.3);否则照常启动,返回 null(变量不注入)。</li>
     *   <li>唯一部门:自动采用;requested 传了必须匹配,不匹配拒绝(防伪造)。</li>
     *   <li>多个部门:requested 必传(员工端/管理台选择后传入);未传拒绝;
     *       传入必须在归属列表中,否则拒绝。</li>
     * </ul>
     *
     * @param startContext       启动上下文(是否含同行政线节点)
     * @param memberOrgUnitIds   申请人全部所属部门 id
     * @param requestedOrgUnitId 请求指定的发起身份部门(可空)
     * @return 发起身份部门 id;申请人无部门且流程不依赖行政线时返回 null
     * @throws IllegalArgumentException 多身份未选、指定身份不在归属列表,或无身份而流程含同行政线节点
     */
    public UUID resolveApplicantOrgUnit(StartContext startContext,
                                        List<UUID> memberOrgUnitIds,
                                        UUID requestedOrgUnitId) {
        List<UUID> memberships = memberOrgUnitIds == null ? List.of() : memberOrgUnitIds;
        if (memberships.isEmpty()) {
            if (requestedOrgUnitId != null) {
                throw new IllegalArgumentException(
                    "发起身份部门与申请人所属部门不符(申请人无部门归属)");
            }
            if (startContext.requiresApplicantOrgUnit()) {
                throw new IllegalArgumentException(
                    "流程包含同行政线审批节点(虚拟角色或同行政线实体角色),"
                        + "申请人尚未分配部门,请先在管理后台分配所属部门");
            }
            return null;
        }
        if (memberships.size() == 1 && requestedOrgUnitId == null) {
            return memberships.get(0);
        }
        if (requestedOrgUnitId == null) {
            throw new IllegalArgumentException(String.format(
                "申请人存在 %d 个组织身份,请选择发起身份后再启动", memberships.size()));
        }
        if (!memberships.contains(requestedOrgUnitId)) {
            throw new IllegalArgumentException(
                "发起身份部门不在申请人所属部门列表中(身份无效或伪造)");
        }
        return requestedOrgUnitId;
    }

    /**
     * 生成启动表单变量清单(仅 start-param 变量)。
     *
     * @param declarations 已部署 BPMN 的上下文声明
     */
    public List<StartFormVariableDto> startForm(List<ContextVariable> declarations) {
        List<StartFormVariableDto> result = new ArrayList<>();
        for (ContextVariable v : declarations) {
            if (!START_PARAM.equals(v.source())) {
                continue;
            }
            result.add(new StartFormVariableDto(
                v.name(), v.type(), v.description(),
                v.initialValue() == null || v.initialValue().isBlank()));
        }
        return result;
    }

    /**
     * 严格声明制校验并构造流程变量(隔离三变量之外的上下文部分)。
     *
     * @param requestVariables 启动请求传入的业务变量(可空)
     * @param auth             当前登录人(initiator 按其身份注入)
     * @return 按声明类型转换 + initial 兜底注入 + system(initiator)自动注入后的变量集
     * @throws IllegalArgumentException 传入未声明 / 非 start-param / 系统注入(initiator)变量,
     *                                  或值与声明类型不符、date/datetime 格式非法
     */
    public Map<String, Object> buildVariables(List<ContextVariable> declarations,
                                              Map<String, Object> requestVariables,
                                              AuthContext auth) {
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, ContextVariable> byName = new LinkedHashMap<>();
        for (ContextVariable v : declarations) {
            byName.put(v.name(), v);
        }

        // 传入变量逐一校验(未声明 / 非 start-param / 系统注入变量均拒绝)
        Map<String, Object> incoming = requestVariables == null ? Map.of() : requestVariables;
        for (Map.Entry<String, Object> e : incoming.entrySet()) {
            ContextVariable decl = byName.get(e.getKey());
            if (decl == null) {
                throw new IllegalArgumentException(
                    "启动变量未在上下文声明中: " + e.getKey() + "(严格声明制,先在「上下文变量」面板声明)");
            }
            if (BpmnContextParser.SYSTEM_SOURCE.equals(decl.source())) {
                throw new IllegalArgumentException(
                    "启动变量 " + e.getKey() + " 为系统注入变量(按登录人自动注入),不允许调用方传入");
            }
            if (!START_PARAM.equals(decl.source())) {
                throw new IllegalArgumentException(
                    "启动变量未标记为 start-param: " + e.getKey());
            }
            if (e.getValue() == null) {
                continue;
            }
            result.put(e.getKey(), convert(decl, e.getValue()));
        }

        // system 来源按登录人自动注入(prompt {{initiator.name}} 等引用的值来源)
        for (ContextVariable decl : declarations) {
            if (BpmnContextParser.SYSTEM_SOURCE.equals(decl.source())) {
                result.put(decl.name(), initiatorValue(auth));
            }
        }

        // initial 兜底注入(启动未传入的变量;system 变量已注入,containsKey 跳过)
        for (ContextVariable decl : declarations) {
            if (result.containsKey(decl.name())
                || decl.initialValue() == null || decl.initialValue().isBlank()) {
                continue;
            }
            result.put(decl.name(), convert(decl, decl.initialValue()));
        }
        return result;
    }

    /**
     * 发起人变量的注入值:字段与发布校验器要求的固定字段清单(userId/name/email)对齐;
     * 显示名缺失时沿 displayName → loginName → email → userId 兜底,保证字段非空
     * (userPrompt 插值把 null 渲染为「空」,发起人卡片至少可显示 user.id)。
     */
    private Map<String, Object> initiatorValue(AuthContext auth) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("userId", auth.authSubject());
        value.put("name", firstNonBlank(
            auth.displayName(), auth.loginName(), auth.email(), auth.authSubject()));
        value.put("email", firstNonBlank(auth.email(), ""));
        return value;
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return "";
    }

    /**
     * 按声明类型转换值;integer/float/boolean 的字符串形式与 JSON 标量都接受,
     * object/array 的字符串形式按 JSON 文本解析。
     */
    private Object convert(ContextVariable decl, Object value) {
        String type = decl.type() == null ? "string" : decl.type();
        return switch (type) {
            case "integer" -> toLong(decl, value);
            case "float" -> toDouble(decl, value);
            case "boolean" -> toBoolean(decl, value);
            case "date", "datetime" -> validateDateFormat(decl, value, type);
            case "object" -> toJson(decl, value, true);
            case "array" -> toJson(decl, value, false);
            default -> value instanceof String s ? s : String.valueOf(value);
        };
    }

    private Long toLong(ContextVariable decl, Object value) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            throw badType(decl, "整数", value);
        }
    }

    private Double toDouble(ContextVariable decl, Object value) {
        if (value instanceof Number n) {
            return n.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            throw badType(decl, "数字", value);
        }
    }

    private Boolean toBoolean(ContextVariable decl, Object value) {
        if (value instanceof Boolean b) {
            return b;
        }
        String s = String.valueOf(value).trim();
        if ("true".equals(s)) {
            return Boolean.TRUE;
        }
        if ("false".equals(s)) {
            return Boolean.FALSE;
        }
        throw badType(decl, "布尔", value);
    }

    /** date/datetime 严格格式校验通过后以原字符串返回。 */
    private String validateDateFormat(ContextVariable decl, Object value, String type) {
        if (!(value instanceof String s)) {
            throw badType(decl, type + " 字符串", value);
        }
        String pattern = type.equals("date")
            ? "\\d{4}-\\d{2}-\\d{2}"
            : "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}";
        if (!s.trim().matches(pattern)) {
            throw new IllegalArgumentException(String.format(
                "变量 %s 声明为 %s,值 %s 不符合严格格式(应为 %s)",
                decl.name(), type, s, type.equals("date") ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"));
        }
        return s.trim();
    }

    /** object/array:JSON 标量/文本转 Map/List。 */
    private Object toJson(ContextVariable decl, Object value, boolean expectObject) {
        if (expectObject && value instanceof Map<?, ?> m) {
            return m;
        }
        if (!expectObject && value instanceof List<?> l) {
            return l;
        }
        try {
            if (expectObject) {
                return objectMapper.readValue(String.valueOf(value), Map.class);
            }
            return objectMapper.readValue(String.valueOf(value), List.class);
        } catch (JsonProcessingException e) {
            throw badType(decl, expectObject ? "JSON 对象" : "JSON 数组", value);
        }
    }

    private IllegalArgumentException badType(ContextVariable decl, String expected, Object value) {
        return new IllegalArgumentException(String.format(
            "变量 %s 声明为 %s,传入值不是%s: %s", decl.name(), decl.type(), expected, value));
    }
}
