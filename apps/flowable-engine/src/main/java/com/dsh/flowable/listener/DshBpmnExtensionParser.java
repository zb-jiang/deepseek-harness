package com.dsh.flowable.listener;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.BaseElement;
import org.flowable.bpmn.model.ExtensionAttribute;
import org.flowable.bpmn.model.ExtensionElement;
import org.flowable.bpmn.model.UserTask;
import org.springframework.stereotype.Component;

/**
 * 从 Flowable {@link UserTask} 的 extensionElements 解析 DSH 特有元数据为
 * {@link DshExtensionProperties} POJO。
 *
 * <p>BPMN XML 期望格式(SPEC §4.8):
 * <pre>{@code
 * <bpmn:userTask id="approveTask" name="审批">
 *   <bpmn:extensionElements>
 *     <dsh:assignmentRule candidateRoleId="role-uuid" taskStrategy="single" />
 *     <dsh:inputSchema>{"type":"object",...}</dsh:inputSchema>
 *     <dsh:outputSchema>{"type":"object","required":["conclusion"]}</dsh:outputSchema>
 *     <dsh:systemPrompt>你是审批助手...</dsh:systemPrompt>
 *     <dsh:userPrompt>请审批:{{upstream.summary}}</dsh:userPrompt>
 *     <dsh:skillRef>approval-helper</dsh:skillRef>
 *     <dsh:skillRef>compliance-check</dsh:skillRef>
 *     <dsh:actionPolicy>
 *       <dsh:timeoutPolicy duration="PT24H" escalateToRoleId="manager-role-id" />
 *       <dsh:sodRule type="not-applicant" />
 *     </dsh:actionPolicy>
 *     <dsh:routingRule expression="output.conclusion=='approved'?'flow_ok':'flow_reject'" />
 *   </bpmn:extensionElements>
 * </bpmn:userTask>
 * }</pre>
 *
 * <p>解析时按 local name(不带 namespace prefix)取 extensionElements map 的 key;
 * dsh 子元素的 attributes 同样按 local name 取(无 namespace 区分),
 * 因为 dsh: 子元素的 attribute 在 XML 中通常不带 namespace prefix。
 */
@Component
public class DshBpmnExtensionParser {

    /** DSH 自定义 namespace,用于和 BPMN standard 区分;此处仅作标记,实际解析按 local name。 */
    public static final String DSH_NAMESPACE = "http://dsh.ai/bpmn";

    /**
     * 解析 UserTask 的 dsh: extensionElements 为 POJO;无 dsh 元素时返回 {@code null}。
     *
     * @param userTask Flowable UserTask model 对象(来自 BpmnModel 缓存)
     * @return DSH 元数据 POJO,或 {@code null}
     */
    public DshExtensionProperties parse(UserTask userTask) {
        Map<String, List<ExtensionElement>> elements = userTask.getExtensionElements();
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        return new DshExtensionProperties(
            parseAssignmentRule(elements.get("assignmentRule")),
            parseTextElement(elements.get("inputSchema")),
            parseTextElement(elements.get("outputSchema")),
            parseTextElement(elements.get("systemPrompt")),
            parseTextElement(elements.get("userPrompt")),
            parseSkillRefs(elements.get("skillRef")),
            parseActionPolicy(elements.get("actionPolicy")),
            parseRoutingRule(elements.get("routingRule"))
        );
    }

    private String parseTextElement(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        String text = elements.get(0).getElementText();
        return text == null || text.isBlank() ? null : text.trim();
    }

    private List<String> parseSkillRefs(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return List.of();
        }
        List<String> result = new ArrayList<>(elements.size());
        for (ExtensionElement e : elements) {
            String text = e.getElementText();
            if (text != null && !text.isBlank()) {
                result.add(text.trim());
            }
        }
        return List.copyOf(result);
    }

    private DshExtensionProperties.AssignmentRule parseAssignmentRule(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        return new DshExtensionProperties.AssignmentRule(
            getAttribute(e, "candidateRoleId"),
            getAttribute(e, "taskStrategy")
        );
    }

    private DshExtensionProperties.ActionPolicy parseActionPolicy(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        return new DshExtensionProperties.ActionPolicy(
            parseTimeoutPolicy(e.getChildElements().get("timeoutPolicy")),
            parseSodRules(e.getChildElements().get("sodRule"))
        );
    }

    private DshExtensionProperties.TimeoutPolicy parseTimeoutPolicy(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        return new DshExtensionProperties.TimeoutPolicy(
            getAttribute(e, "duration"),
            getAttribute(e, "escalateToRoleId"),
            getAttribute(e, "escalateToUserId")
        );
    }

    private List<DshExtensionProperties.SodRule> parseSodRules(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return List.of();
        }
        List<DshExtensionProperties.SodRule> result = new ArrayList<>(elements.size());
        for (ExtensionElement e : elements) {
            String type = getAttribute(e, "type");
            if (type != null && !type.isBlank()) {
                result.add(new DshExtensionProperties.SodRule(type.trim()));
            }
        }
        return List.copyOf(result);
    }

    private DshExtensionProperties.RoutingRule parseRoutingRule(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        String expr = getAttribute(e, "expression");
        if (expr == null || expr.isBlank()) {
            expr = e.getElementText();
        }
        return expr == null || expr.isBlank() ? null : new DshExtensionProperties.RoutingRule(expr.trim());
    }

    /**
     * 从 BaseElement 的 attributes map 按 local name 取 attribute value(无 namespace 区分)。
     */
    private String getAttribute(BaseElement element, String name) {
        List<ExtensionAttribute> attrs = element.getAttributes().get(name);
        if (attrs == null || attrs.isEmpty()) {
            return null;
        }
        ExtensionAttribute attr = attrs.get(0);
        return attr.getValue();
    }
}
