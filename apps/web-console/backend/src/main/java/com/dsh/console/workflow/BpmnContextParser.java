package com.dsh.console.workflow;

import java.util.ArrayList;
import java.util.List;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * BPMN 流程级上下文声明解析器(design 2026-09-01 §4)。
 *
 * <p>解析 process 的 {@code dsh:contextVariables} 为声明清单,供发布校验
 * (BpmnValidationService 四查)与启动校验(ProcessInstanceService 严格声明制)共用。
 * 也提供 namespace-aware + XXE 防护的 XML 解析辅助。
 */
public final class BpmnContextParser {

    /** dsh: 命名空间;与引擎 DshBpmnExtensionParser、前端 dsh-moddle.ts 一致。 */
    public static final String DSH_NS = "http://dsh.ai/bpmn";

    /** bpmn: 命名空间。 */
    public static final String BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";

    /** 系统注入来源标记(source 属性值);当前唯一 system 注入器是发起人变量 initiator。 */
    public static final String SYSTEM_SOURCE = "system";

    /** 系统注入的发起人变量名;启动时按登录人注入 userId/name/email 三字段。 */
    public static final String INITIATOR_VARIABLE_NAME = "initiator";

    private BpmnContextParser() {
    }

    /**
     * 上下文变量声明(name/type/description/initialValue/itemType/source + 嵌套字段清单)。
     *
     * @param fields object 字段清单;array 且 itemType=object 时为元素字段清单;否则空列表
     */
    public record ContextVariable(String name, String type, String description,
                                  String initialValue, String itemType, String source,
                                  List<ContextVariable> fields) {
    }

    /**
     * DSH backend task 节点信息(design 2026-09-14 §3.1)。
     *
     * @param backendProfileUrl 本条目归属的 backend profile 调用 URL:单实例形态取
     *                          dsh:backendTask@backendProfileUrl 属性,多实例形态取
     *                          dsh:backendProfile 列表逐行的 url(design §13.4)
     * @param skillRefs         节点引用的 skill 名清单(dsh:skillRef 正文,可能为空)
     */
    public record BackendTaskInfo(String backendProfileUrl, List<String> skillRefs) {
    }

    /**
     * userTask 的 {@code dsh:assignmentRule} 解析结果(design 2026-09-19 组织维度审批路由)。
     *
     * <p>属性保持原样(不归一化):启动校验只关心 {@link #requiresApplicantOrgUnit()},
     * 发布校验(BpmnValidationService)负责枚举合法性与互斥规则,阶段 4 属性回显需要
     * 原值。与引擎 DshBpmnExtensionParser 的属性集对齐。
     *
     * @param taskId          userTask id
     * @param taskName        userTask name
     * @param candidateRoleId 实体候选角色 id;虚拟角色时为 null
     * @param orgScope        组织范围:sameLine / fixedUnit / global;null=未配置(存量)
     * @param virtualRole     虚拟角色:parent / grandparent / child / grandchild;null=实体角色
     * @param fixedUnitId     指定部门 id;orgScope=fixedUnit 时使用
     */
    public record AssignmentRuleInfo(String taskId, String taskName, String candidateRoleId,
                                     String orgScope, String virtualRole, String fixedUnitId) {

        /**
         * 该节点是否依赖申请人的行政线(虚拟角色或 sameLine 实体角色,design §5.3):
         * 申请人须已分配部门,启动校验据此拒绝。
         */
        public boolean requiresApplicantOrgUnit() {
            return virtualRole != null || "sameLine".equals(orgScope);
        }
    }

    /**
     * 解析全部 userTask 的 {@code dsh:assignmentRule}(含组织维度新属性)。
     *
     * <p>供启动校验(同行政线节点要求申请人有部门)与发布校验共用;无 assignmentRule
     * 的任务不产出条目。assignmentRule 挂在 userTask 的 extensionElements 下,
     * 与设计器序列化、引擎解析位置一致。
     */
    public static List<AssignmentRuleInfo> parseAssignmentRules(Document doc) {
        List<AssignmentRuleInfo> result = new ArrayList<>();
        NodeList tasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < tasks.getLength(); i++) {
            Element task = (Element) tasks.item(i);
            Element extElements = extensionElementsOf(task);
            if (extElements == null) {
                continue;
            }
            Element rule = dshChild(extElements, "assignmentRule");
            if (rule == null) {
                continue;
            }
            result.add(new AssignmentRuleInfo(
                task.getAttribute("id"),
                task.getAttribute("name"),
                attr(rule, "candidateRoleId"),
                attr(rule, "orgScope"),
                attr(rule, "virtualRole"),
                attr(rule, "fixedUnitId")));
        }
        return List.copyOf(result);
    }

    /**
     * 解析全部 DSH backend task 节点(含 dsh:backendTask 扩展的 serviceTask)。
     *
     * <p>skill 归属聚合(backendprofile 模块)与发布校验共用:聚合按 URL 归属收
     * skillRefs,校验查 URL 存在性。单实例节点产出一条(属性 URL);多实例节点
     * 逐行展开 dsh:backendProfile 列表(每行一条,同一节点的 skillRefs 归属到
     * 每个被绑定的 profile),空 url 行跳过(发布校验负责报错)。
     */
    public static List<BackendTaskInfo> parseBackendTasks(Document doc) {
        List<BackendTaskInfo> result = new ArrayList<>();
        org.w3c.dom.NodeList tasks = doc.getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < tasks.getLength(); i++) {
            Element task = (Element) tasks.item(i);
            Element extElements = extensionElementsOf(task);
            if (extElements == null) {
                continue;
            }
            Element backendEl = dshChild(extElements, "backendTask");
            if (backendEl == null) {
                continue;
            }
            List<String> skillRefs = new ArrayList<>();
            for (Element el : childElements(extElements, "skillRef")) {
                String name = el.getTextContent().trim();
                if (!name.isEmpty()) {
                    skillRefs.add(name);
                }
            }
            result.add(new BackendTaskInfo(backendEl.getAttribute("backendProfileUrl"), List.copyOf(skillRefs)));
            for (Element el : childElements(backendEl, "backendProfile")) {
                String url = el.getAttribute("url").trim();
                if (!url.isEmpty()) {
                    result.add(new BackendTaskInfo(url, List.copyOf(skillRefs)));
                }
            }
        }
        return List.copyOf(result);
    }

    /** serviceTask 的 bpmn:extensionElements 直接子元素;无则 null。 */
    private static Element extensionElementsOf(Element task) {
        org.w3c.dom.NodeList children = task.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element e
                && BPMN_NS.equals(e.getNamespaceURI())
                && "extensionElements".equals(e.getLocalName())) {
                return e;
            }
        }
        return null;
    }

    /** extensionElements 下指定 local name 的 dsh: 直接子元素;无则 null。 */
    private static Element dshChild(Element extElements, String localName) {
        for (Element el : childElements(extElements, localName)) {
            return el;
        }
        return null;
    }

    /**
     * namespace-aware + XXE 防护地解析 BPMN XML。
     */
    public static Document parseXml(String bpmnXml) throws Exception {
        javax.xml.parsers.DocumentBuilderFactory factory =
            javax.xml.parsers.DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        javax.xml.parsers.DocumentBuilder builder = factory.newDocumentBuilder();
        return builder.parse(
            new java.io.ByteArrayInputStream(bpmnXml.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    /**
     * 解析第一个 process 元素的 id(BPMN process key)。
     *
     * <p>发布时写入 {@code workflow_definitions.bpmn_process_key}:procdefId 每次发布
     * 都会随引擎版本递增而变化,key 跨发布版本稳定,历史实例按 procdefId 反查应用归属
     * miss 时以 key 回退。解析失败直接抛出——发布前置校验刚验证过同一份 XML,
     * 此处失败属于环境异常,发布事务应回滚(fail loud)。
     */
    public static String parseProcessKey(String bpmnXml) {
        Document doc;
        try {
            doc = parseXml(bpmnXml);
        } catch (Exception e) {
            throw new IllegalStateException("解析 BPMN XML 失败", e);
        }
        NodeList processes = doc.getElementsByTagNameNS(BPMN_NS, "process");
        if (processes.getLength() == 0) {
            throw new IllegalStateException("BPMN XML 中没有 process 元素");
        }
        String id = ((Element) processes.item(0)).getAttribute("id");
        if (id == null || id.isBlank()) {
            throw new IllegalStateException("BPMN process 元素缺少 id 属性");
        }
        return id;
    }

    /**
     * 解析第一个 process 的 {@code dsh:contextVariables} 声明;无声明返回空列表。
     */
    public static List<ContextVariable> parseContextVariables(Document doc) {
        NodeList processes = doc.getElementsByTagNameNS(BPMN_NS, "process");
        if (processes.getLength() == 0) {
            return List.of();
        }
        Element process = (Element) processes.item(0);
        NodeList containers = process.getElementsByTagNameNS(DSH_NS, "contextVariables");
        if (containers.getLength() == 0) {
            return List.of();
        }
        return parseVariables((Element) containers.item(0));
    }

    private static List<ContextVariable> parseVariables(Element container) {
        List<ContextVariable> result = new ArrayList<>();
        for (Element el : childElements(container, "contextVariable")) {
            result.add(toVariable(el));
        }
        return List.copyOf(result);
    }

    private static ContextVariable toVariable(Element el) {
        return new ContextVariable(
            attr(el, "name"),
            attr(el, "type"),
            attr(el, "description"),
            attr(el, "initialValue"),
            attr(el, "itemType"),
            attr(el, "source"),
            parseFields(el));
    }

    private static List<ContextVariable> parseFields(Element parent) {
        List<ContextVariable> result = new ArrayList<>();
        for (Element el : childElements(parent, "field")) {
            result.add(toVariable(el));
        }
        return List.copyOf(result);
    }

    /** 只取直接子元素(嵌套 field 不能用后代搜索,否则深层字段会重复计入上层)。 */
    private static List<Element> childElements(Element parent, String localName) {
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

    private static String attr(Element el, String name) {
        String v = el.getAttribute(name);
        return v == null || v.isBlank() ? null : v;
    }
}
