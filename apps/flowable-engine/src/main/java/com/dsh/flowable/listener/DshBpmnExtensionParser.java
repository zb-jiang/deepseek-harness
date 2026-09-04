package com.dsh.flowable.listener;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.BaseElement;
import org.flowable.bpmn.model.ExtensionAttribute;
import org.flowable.bpmn.model.ExtensionElement;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.UserTask;
import org.springframework.stereotype.Component;

/**
 * 从 Flowable BPMN 的 extensionElements 解析 DSH 特有元数据为 POJO。
 *
 * BPMN XML 期望格式:
 * <bpmn:userTask id="approveTask" name="审批">
 *   <bpmn:extensionElements>
 *     <dsh:assignmentRule candidateRoleId="role-uuid" />
 *     <dsh:userPrompt text="请审批:{{execution.summary}}"/>
 *     <dsh:skillRef>approval-helper</dsh:skillRef>
 *     <dsh:skillRef>compliance-check</dsh:skillRef>
 *     <dsh:actionPolicy>
 *       <dsh:timeoutPolicy duration="PT24H" escalateToRoleId="manager-role-id" />
 *       <dsh:sodRule type="not-applicant" />
 *     </dsh:actionPolicy>
 *     <dsh:outputMappings>
 *       <dsh:mapping source="" target="managerApproval" />
 *     </dsh:outputMappings>
 *   </bpmn:extensionElements>
 * </bpmn:userTask>
 *
 * <bpmn:process id="expense">
 *   <bpmn:extensionElements>
 *     <dsh:contextVariables>
 *       <dsh:contextVariable name="managerApproval" type="object" description="经理审批结果">
 *         <dsh:field name="decision" type="string" />
 *       </dsh:contextVariable>
 *     </dsh:contextVariables>
 *   </bpmn:extensionElements>
 * </bpmn:process>
 *
 * 已移除:dsh:inputSchema(改为直接从 process variables 树读取)、
 * dsh:routingRule(改为走 SequenceFlow 原生 conditionExpression)、
 * dsh:outputSchema / dsh:systemPrompt(输出 JSON 格式并入 userPrompt 文本)、
 * assignmentRule 的 taskStrategy 属性(改用 BPMN 原生多实例表达)。
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
            parseUserPrompt(elements.get("userPrompt")),
            parseSkillRefs(elements.get("skillRef")),
            parseActionPolicy(elements.get("actionPolicy")),
            parseOutputMappings(elements.get("outputMappings")),
            null
        );
    }

    /**
     * 解析 Process 的 {@code dsh:contextVariables} 为声明清单;无声明返回空列表。
     */
    public List<DshContextVariable> parseContextVariables(Process process) {
        Map<String, List<ExtensionElement>> elements = process.getExtensionElements();
        if (elements == null || elements.isEmpty()) {
            return List.of();
        }
        List<ExtensionElement> containers = elements.get("contextVariables");
        if (containers == null || containers.isEmpty()) {
            return List.of();
        }
        List<ExtensionElement> vars = containers.get(0).getChildElements().get("contextVariable");
        if (vars == null || vars.isEmpty()) {
            return List.of();
        }
        List<DshContextVariable> result = new ArrayList<>(vars.size());
        for (ExtensionElement v : vars) {
            result.add(new DshContextVariable(
                getAttribute(v, "name"),
                getAttribute(v, "type"),
                getAttribute(v, "description"),
                getAttribute(v, "initialValue"),
                getAttribute(v, "itemType"),
                getAttribute(v, "source"),
                parseFields(v.getChildElements().get("field"))
            ));
        }
        return List.copyOf(result);
    }

    private List<DshContextVariable.Field> parseFields(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return List.of();
        }
        List<DshContextVariable.Field> result = new ArrayList<>(elements.size());
        for (ExtensionElement e : elements) {
            result.add(new DshContextVariable.Field(
                getAttribute(e, "name"),
                getAttribute(e, "type"),
                getAttribute(e, "description"),
                parseFields(e.getChildElements().get("field"))
            ));
        }
        return List.copyOf(result);
    }

    private List<DshExtensionProperties.OutputMapping> parseOutputMappings(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return List.of();
        }
        List<ExtensionElement> mappings = elements.get(0).getChildElements().get("mapping");
        if (mappings == null || mappings.isEmpty()) {
            return List.of();
        }
        List<DshExtensionProperties.OutputMapping> result = new ArrayList<>(mappings.size());
        for (ExtensionElement e : mappings) {
            result.add(new DshExtensionProperties.OutputMapping(
                getAttribute(e, "source"),
                getAttribute(e, "target")
            ));
        }
        return List.copyOf(result);
    }

    /**
     * 解析 userPrompt 的 {@code text} 属性;无元素或属性为空返回 null。
     *
     * <p>prompt 存 XML 属性而非元素正文:引擎 StAX 配置
     * {@code IS_REPLACING_ENTITY_REFERENCES=false} 时,含引号的正文被切成多个
     * CHARACTER 事件,Flowable 的 setElementText 只保留最后一段(JSON 骨架会被截断);
     * 属性值由 getAttributeValue 一次性完整解码,不受事件切分影响
     * (与 {@code flowable:class} 等 Flowable 扩展属性的存储模式一致)。</p>
     */
    private String parseUserPrompt(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        String text = getAttribute(elements.get(0), "text");
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
            getAttribute(e, "candidateRoleId")
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
