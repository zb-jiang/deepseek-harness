package com.dsh.console.workflow;

import com.dsh.console.role.AppRoleJdbcRepository;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import com.dsh.console.workflow.BpmnContextParser.ContextVariable;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * BPMN 校验服务。
 *
 * <p>对应 spec §12.10 应用隔离不变量 + §5.7 节点定义约束 + §13.4 应用隔离设计:
 * <ul>
 *   <li>BPMN 是合法 XML 且根元素是 definitions。</li>
 *   <li>每个 human 节点的 {@code flowable:candidateGroups} 或 {@code dsh:assignmentRule.candidateRoleId}
 *       引用的 role_id 必属于该 BPMN 所属应用。</li>
 *   <li>userTask 至少要有候选角色或候选用户(spec §7.2 规则 1)。</li>
 *   <li>serviceTask 必须配 {@code flowable:delegateExpression}(值任意,spec §10.1 自动节点规则)。</li>
 * </ul>
 *
 * <p>Process Context 发布校验四查(design 2026-09-01 §8):
 * <ol>
 *   <li>prompt 引用存在性:userTask 的 userPrompt {@code {{var.field}}} 占位符,
 *       根变量已声明且点路径沿字段清单合法。</li>
 *   <li>条件表达式引用存在性:网关/连线/Conditional 事件 {@code ${}} 静态解析,
 *       标识符已声明或属内置豁免(引擎多实例内置变量 + 应用隔离三变量)。</li>
 *   <li>映射 target 存在性:userTask 输出映射的 target 根变量已声明且点路径合法。</li>
 *   <li>变量引用来源闭环:prompt、条件表达式、消费声明引用的变量必有来源
 *       (start-param / initial / 输出映射 target / 产出声明 / 豁免)。</li>
 * </ol>
 */
@Service
public class BpmnValidationService {

    private static final String FLOWABLE_NS = "http://flowable.org/bpmn";
    private static final String BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
    private static final String DSH_NS = BpmnContextParser.DSH_NS;

    /** userPrompt 占位符 {@code {{var.field}}}(design §7)。 */
    private static final Pattern PROMPT_PLACEHOLDER = Pattern.compile("\\{\\{([^}]+)}}");

    /** JUEL 表达式 {@code ${...}}(design §7)。 */
    private static final Pattern JUEL_EXPRESSION = Pattern.compile("\\$\\{([^}]*)}");

    /** JUEL 内标识符(bean 名/变量名/方法名)。 */
    private static final Pattern IDENTIFIER = Pattern.compile("[a-zA-Z_][a-zA-Z0-9_]*");

    /** 引用存在性与来源闭环的豁免标识符:多实例引擎内置变量 + 应用隔离三变量。 */
    private static final Set<String> BUILTIN_IDENTIFIERS = Set.of(
        "nrOfInstances", "nrOfActiveInstances", "nrOfCompletedInstances", "loopCounter",
        "dsh_applicant_user_id", "dsh_app_id", "dsh_workflow_definition_id");

    private final AppRoleJdbcRepository roleRepository;

    public BpmnValidationService(AppRoleJdbcRepository roleRepository) {
        this.roleRepository = roleRepository;
    }

    /**
     * 校验 BPMN XML。
     *
     * @param bpmnXml   BPMN XML 字符串
     * @param appId     该 BPMN 所属应用 ID,用于校验 role_id 归属
     */
    public BpmnValidationResult validate(String bpmnXml, UUID appId) {
        if (bpmnXml == null || bpmnXml.isBlank()) {
            return BpmnValidationResult.fail("BPMN XML 不能为空");
        }

        Document doc;
        try {
            doc = BpmnContextParser.parseXml(bpmnXml);
        } catch (Exception e) {
            return BpmnValidationResult.fail("BPMN XML 解析失败: " + e.getMessage());
        }

        // 1) 根元素必须是 bpmn:definitions
        Element root = doc.getDocumentElement();
        if (!BPMN_NS.equals(root.getNamespaceURI()) || !"definitions".equals(root.getLocalName())) {
            return BpmnValidationResult.fail("根元素必须是 bpmn:definitions,实际: "
                + root.getNamespaceURI() + ":" + root.getLocalName());
        }

        List<String> errors = new ArrayList<>();

        // 2) 取本应用所有 role_id 集合,校验归属
        List<AppRoleDto> appRoles = roleRepository.listByApp(appId);
        Set<String> validRoleIds = appRoles.stream()
            .map(r -> r.id().toString())
            .collect(Collectors.toSet());
        validateRoleReferences(root, validRoleIds, errors);

        // 3) serviceTask 必配 delegateExpression
        validateServiceTaskImplementations(root, errors);

        // 4) Process Context 四查
        validateContextReferences(doc, errors);

        if (errors.isEmpty()) {
            return BpmnValidationResult.ok();
        }
        return BpmnValidationResult.fail(errors);
    }

    // ===== 应用隔离与节点定义(原有) =====

    private void validateRoleReferences(Element root, Set<String> validRoleIds, List<String> errors) {
        NodeList userTasks = root.getOwnerDocument().getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");

            // flowable:candidateGroups 引用的 role_id 必属本应用
            String candidateGroups = task.getAttributeNS(FLOWABLE_NS, "candidateGroups");
            if (candidateGroups != null && !candidateGroups.isBlank()) {
                for (String gid : candidateGroups.split(",")) {
                    String trimmed = gid.trim();
                    if (!trimmed.isEmpty() && !validRoleIds.contains(trimmed)) {
                        errors.add(String.format(
                            "userTask[id=%s, name=%s] 的 candidateGroups 引用了不属于本应用的 role_id: %s (spec §12.10 应用隔离不变量)",
                            taskId, taskName, trimmed));
                    }
                }
            }

            // dsh:assignmentRule.candidateRoleId 必属本应用
            NodeList dshAssignments = task.getElementsByTagNameNS(DSH_NS, "assignmentRule");
            for (int j = 0; j < dshAssignments.getLength(); j++) {
                Element ar = (Element) dshAssignments.item(j);
                String candidateRoleId = ar.getAttribute("candidateRoleId");
                if (candidateRoleId != null && !candidateRoleId.isBlank()
                    && !validRoleIds.contains(candidateRoleId)) {
                    errors.add(String.format(
                        "userTask[id=%s] 的 dsh:assignmentRule.candidateRoleId 不属于本应用: %s",
                        taskId, candidateRoleId));
                }
            }
        }
    }

    private void validateServiceTaskImplementations(Element root, List<String> errors) {
        NodeList serviceTasks = root.getOwnerDocument().getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            String delegate = task.getAttributeNS(FLOWABLE_NS, "delegateExpression");
            if (delegate == null || delegate.isBlank()) {
                errors.add(String.format(
                    "serviceTask[id=%s, name=%s] 缺少 flowable:delegateExpression(spec §10.1 自动节点规则)",
                    task.getAttribute("id"), task.getAttribute("name")));
            }
        }
    }

    // ===== Process Context 四查(design 2026-09-01 §8) =====

    private void validateContextReferences(Document doc, List<String> errors) {
        List<ContextVariable> declarations = BpmnContextParser.parseContextVariables(doc);
        Map<String, ContextVariable> byName = declarations.stream()
            .filter(v -> v.name() != null)
            .collect(Collectors.toMap(ContextVariable::name, v -> v, (a, b) -> a));

        // 重名声明直接报错(流程内唯一)
        Set<String> seen = new HashSet<>();
        for (ContextVariable v : declarations) {
            if (v.name() != null && !seen.add(v.name())) {
                errors.add("上下文变量重名: " + v.name());
            }
        }

        // 来源集:start-param / initial / 输出映射 target 根 / 产出声明 / 豁免
        Set<String> sources = new LinkedHashSet<>();
        for (ContextVariable v : declarations) {
            if ("start-param".equals(v.source())
                || (v.initialValue() != null && !v.initialValue().isBlank())) {
                sources.add(v.name());
            }
        }

        // 引用集 + 查 1/3(userTask 遍历一次完成:prompt 引用 + 映射 target,
        // 映射 target 根同时计入来源集)
        Set<String> referenced = new LinkedHashSet<>();

        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String location = "userTask[id=" + task.getAttribute("id") + "]";
            checkPromptReferences(task, location, byName, referenced, errors);
            checkOutputMappings(task, location, byName, sources, errors);
        }

        // 查 2:条件表达式(sequenceFlow / conditionalEvent)
        checkConditionExpressions(doc, byName, referenced, errors);

        // 消费/产出声明:inputVariables 收引用,outputVariables 收来源
        checkIoVariableDeclarations(doc, byName, referenced, sources, errors);

        // 查 4:来源闭环
        for (String ref : referenced) {
            if (!sources.contains(ref)) {
                errors.add(String.format(
                    "变量 %s 被引用但没有来源(start-param / 初始值 / 输出映射 / 产出声明均无)", ref));
            }
        }
    }

    /** 查 1:userPrompt {{}} 占位符——根变量已声明、点路径沿字段清单合法。 */
    private void checkPromptReferences(Element userTask, String location,
                                       Map<String, ContextVariable> byName,
                                       Set<String> referenced, List<String> errors) {
        for (String prompt : dshPrompts(userTask)) {
            Matcher m = PROMPT_PLACEHOLDER.matcher(prompt);
            while (m.find()) {
                String path = m.group(1).trim();
                String rootName = rootSegment(path);
                ContextVariable decl = byName.get(rootName);
                if (decl == null) {
                    errors.add(String.format(
                        "%s 的 userPrompt 引用未声明变量: %s(先在「上下文变量」面板声明)", location, rootName));
                    continue;
                }
                referenced.add(rootName);
                checkFieldPath(location, "userPrompt", path, decl, errors);
            }
        }
    }

    /** 查 3:输出映射 target——根变量已声明、点路径合法;target 根计入来源集。 */
    private void checkOutputMappings(Element userTask, String location,
                                      Map<String, ContextVariable> byName,
                                      Set<String> sources, List<String> errors) {
        for (Element mappings : dshChildren(userTask, "outputMappings")) {
            for (Element mapping : dshChildren(mappings, "mapping")) {
                String target = attrOrNull(mapping, "target");
                if (target == null || target.isBlank()) {
                    errors.add(location + " 的输出映射缺少 target");
                    continue;
                }
                String rootName = rootSegment(target.trim());
                ContextVariable decl = byName.get(rootName);
                if (decl == null) {
                    errors.add(String.format(
                        "%s 的输出映射 target 指向未声明变量: %s", location, rootName));
                    continue;
                }
                sources.add(rootName);
                checkFieldPath(location, "输出映射 target", target.trim(), decl, errors);
            }
        }
    }

    /**
     * 查 2:网关/连线/Conditional 事件的条件表达式 {@code ${}}——
     * 标识符已声明或属内置豁免;声明的计入引用集(参与来源闭环)。
     */
    private void checkConditionExpressions(Document doc, Map<String, ContextVariable> byName,
                                           Set<String> referenced, List<String> errors) {
        // sequenceFlow 的 conditionExpression
        NodeList flows = doc.getElementsByTagNameNS(BPMN_NS, "sequenceFlow");
        for (int i = 0; i < flows.getLength(); i++) {
            Element flow = (Element) flows.item(i);
            for (String expr : bpmnTexts(flow, "conditionExpression")) {
                checkJuel(expr, "sequenceFlow[id=" + flow.getAttribute("id") + "]",
                    byName, referenced, errors);
            }
        }
        // conditionalEventDefinition 的 condition
        NodeList conditions = doc.getElementsByTagNameNS(BPMN_NS, "condition");
        for (int i = 0; i < conditions.getLength(); i++) {
            Element cond = (Element) conditions.item(i);
            String expr = cond.getTextContent();
            if (expr != null && !expr.isBlank()) {
                checkJuel(expr, "conditionalEvent[" + cond.getAttribute("id") + "]",
                    byName, referenced, errors);
            }
        }
    }

    /** JUEL 标识符逐一检查:已声明 → 计入引用;豁免 → 忽略;否则报未声明。 */
    private void checkJuel(String expr, String location, Map<String, ContextVariable> byName,
                          Set<String> referenced, List<String> errors) {
        // 去掉字符串字面量再提标识符,避免 'approved' 误报
        String withoutLiterals = expr.replaceAll("'[^']*'", "").replaceAll("\"[^\"]*\"", "");
        Matcher m = JUEL_EXPRESSION.matcher(withoutLiterals);
        while (m.find()) {
            Matcher ids = IDENTIFIER.matcher(m.group(1));
            Set<String> seenInExpr = new HashSet<>();
            while (ids.find()) {
                String id = ids.group();
                if (!seenInExpr.add(id)) {
                    continue;
                }
                if (byName.containsKey(id)) {
                    referenced.add(id);
                } else if (!BUILTIN_IDENTIFIERS.contains(id)) {
                    errors.add(String.format(
                        "%s 的条件表达式引用未声明变量: %s(先在「上下文变量」面板声明)", location, id));
                }
            }
        }
    }

    /** 消费声明收引用、产出声明收来源;两者都要求变量已声明。 */
    private void checkIoVariableDeclarations(Document doc, Map<String, ContextVariable> byName,
                                             Set<String> referenced, Set<String> sources,
                                             List<String> errors) {
        NodeList refs = doc.getElementsByTagNameNS(DSH_NS, "variableRef");
        for (int i = 0; i < refs.getLength(); i++) {
            Element ref = (Element) refs.item(i);
            String name = attrOrNull(ref, "ref");
            if (name == null || name.isBlank()) {
                continue;
            }
            boolean isOutput = isInside(ref, "outputVariables");
            if (!byName.containsKey(name)) {
                errors.add(String.format(
                    "%s声明的变量未声明: %s", isOutput ? "产出" : "消费", name));
                continue;
            }
            if (isOutput) {
                sources.add(name);
            } else {
                referenced.add(name);
            }
        }
    }

    /**
     * 点路径合法检查:去掉数组索引段([0])后沿字段清单逐段走;
     * array 变量的字段清单视为元素字段清单(itemType=object 时配置)。
     */
    private void checkFieldPath(String location, String what, String rawPath,
                               ContextVariable rootDecl, List<String> errors) {
        String cleaned = rawPath.replaceAll("\\[\\d+]", "");
        String[] segments = cleaned.split("\\.");
        List<ContextVariable> current = rootDecl.fields();
        for (int i = 1; i < segments.length; i++) {
            String seg = segments[i].trim();
            if (seg.isEmpty()) {
                continue;
            }
            ContextVariable match = current.stream()
                .filter(f -> seg.equals(f.name()))
                .findFirst().orElse(null);
            if (match == null) {
                errors.add(String.format(
                    "%s 的 %s 路径 %s 中字段 %s 不在 %s 的字段清单", location, what, rawPath, seg, segments[0]));
                return;
            }
            current = match.fields();
        }
    }

    // ===== DOM 辅助 =====

    private static String rootSegment(String path) {
        String cleaned = path.replaceAll("\\[\\d+]", "");
        int dot = cleaned.indexOf('.');
        return dot < 0 ? cleaned.trim() : cleaned.substring(0, dot).trim();
    }

    /**
     * dsh:userPrompt 的 {@code text} 属性集合。
     *
     * <p>prompt 存 XML 属性而非元素正文(与引擎 DshBpmnExtensionParser、前端
     * dsh-moddle 对齐):引擎 StAX 非实体替换模式下含引号的正文会被事件切分截断。</p>
     */
    private static List<String> dshPrompts(Element parent) {
        List<String> result = new ArrayList<>();
        for (Element el : dshChildren(parent, "userPrompt")) {
            String text = attrOrNull(el, "text");
            if (text != null) {
                result.add(text);
            }
        }
        return result;
    }

    /** dsh: 命名空间下指定 local name 的直接子元素(不递归,避免嵌套误收)。 */
    private static List<Element> dshChildren(Element parent, String localName) {
        List<Element> result = new ArrayList<>();
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element e
                && DSH_NS.equals(e.getNamespaceURI())
                && localName.equals(e.getLocalName())) {
                result.add(e);
            }
        }
        return result;
    }

    /** bpmn: 命名空间下指定 local name 的直接子元素文本集合。 */
    private static List<String> bpmnTexts(Element parent, String localName) {
        List<String> result = new ArrayList<>();
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element e
                && BPMN_NS.equals(e.getNamespaceURI())
                && localName.equals(e.getLocalName())) {
                String text = e.getTextContent();
                if (text != null && !text.isBlank()) {
                    result.add(text);
                }
            }
        }
        return result;
    }

    /** 判断元素是否在指定 local name 的 dsh: 祖先内。 */
    private static boolean isInside(Element el, String ancestorLocalName) {
        org.w3c.dom.Node node = el.getParentNode();
        while (node != null) {
            if (node instanceof Element e
                && DSH_NS.equals(e.getNamespaceURI())
                && ancestorLocalName.equals(e.getLocalName())) {
                return true;
            }
            node = node.getParentNode();
        }
        return false;
    }

    private static String attrOrNull(Element el, String name) {
        String v = el.getAttribute(name);
        return v == null || v.isBlank() ? null : v;
    }
}
