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
