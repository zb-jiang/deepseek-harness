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
 * 从 Flowable UserTask 的 extensionElements 解析 DSH 特有元数据为 DshExtensionProperties POJO。
 *
 * BPMN XML 期望格式:
 * <bpmn:userTask id="approveTask" name="审批">
 *   <bpmn:extensionElements>
 *     <dsh:assignmentRule candidateRoleId="role-uuid" taskStrategy="single" />
 *     <dsh:outputSchema>{"type":"object","required":["conclusion"]}</dsh:outputSchema>
 *     <dsh:systemPrompt>你是审批助手...</dsh:systemPrompt>
 *     <dsh:userPrompt>请审批:{{execution.summary}}</dsh:userPrompt>
 *     <dsh:skillRef>approval-helper</dsh:skillRef>
 *     <dsh:skillRef>compliance-check</dsh:skillRef>
 *     <dsh:actionPolicy>
 *       <dsh:timeoutPolicy duration="PT24H" escalateToRoleId="manager-role-id" />
 *       <dsh:sodRule type="not-applicant" />
 *     </dsh:actionPolicy>
 *   </bpmn:extensionElements>
 * </bpmn:userTask>
 *
 * 已移除:dsh:inputSchema(改为直接从 process variables 树读取)、
 * dsh:routingRule(改为走 SequenceFlow 原生 conditionExpression)。
 */
@Component
public class DshBpmnExtensionParser {

    /** DSH 自定义 namespace。 */
    public static final String DSH_NAMESPACE = "http://dsh.ai/bpmn";

    /**
     * 解析 UserTask 的 dsh: extensionElements 为 POJO;无 dsh 元素时返回 null。
     */
    public DshExtensionProperties parse(UserTask userTask) {
        Map<String, List<ExtensionElement>> elements = userTask.getExtensionElements();
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        return new DshExtensionProperties(
            parseAssignmentRule(elements.get("assignmentRule")),
            parseTextElement(elements.get("outputSchema")),
            parseTextElement(elements.get("systemPrompt")),
            parseTextElement(elements.get("userPrompt")),
            parseSkillRefs(elements.get("skillRef")),
            parseActionPolicy(elements.get("actionPolicy"))
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
