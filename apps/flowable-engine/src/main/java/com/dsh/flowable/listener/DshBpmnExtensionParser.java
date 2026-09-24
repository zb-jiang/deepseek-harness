package com.dsh.flowable.listener;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.flowable.bpmn.model.BaseElement;
import org.flowable.bpmn.model.ExtensionAttribute;
import org.flowable.bpmn.model.ExtensionElement;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.ServiceTask;
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
            parseVotingRule(elements.get("votingRule")),
            parseUserPrompt(elements.get("userPrompt")),
            parseSkillRefs(elements.get("skillRef")),
            parseActionPolicy(elements.get("actionPolicy")),
            parseOutputMappings(elements.get("outputMappings")),
            null,
            null
        );
    }

    /**
     * 解析 ServiceTask 的 dsh: extensionElements(design 2026-09-14 §6.1;多实例与
     * 计票扩展 2026-09-15);无 {@code dsh:backendTask} 元素(普通自动节点)返回 null,
     * 有则填 backendTask 标记(单实例 URL + 多实例 profile 列表)并同构复用
     * userPrompt/skillRefs/outputMappings/votingRule 解析
     * (assignmentRule/actionPolicy 对后端任务无意义,恒 null;
     * contextVariables 由 resolver 按 process 级声明合并)。
     */
    public DshExtensionProperties parseBackendTask(ServiceTask serviceTask) {
        Map<String, List<ExtensionElement>> elements = serviceTask.getExtensionElements();
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        List<ExtensionElement> backendElements = elements.get("backendTask");
        if (backendElements == null || backendElements.isEmpty()) {
            return null;
        }
        String url = getAttribute(backendElements.get(0), "backendProfileUrl");
        DshExtensionProperties.BackendTask backendTask = new DshExtensionProperties.BackendTask(
            url == null || url.isBlank() ? null : url.trim(),
            parseProfileUrls(backendElements.get(0)));
        return new DshExtensionProperties(
            null,
            parseVotingRule(elements.get("votingRule")),
            parseUserPrompt(elements.get("userPrompt")),
            parseSkillRefs(elements.get("skillRef")),
            null,
            parseOutputMappings(elements.get("outputMappings")),
            null,
            backendTask
        );
    }

    /**
     * 解析普通 ServiceTask(无 {@code dsh:backendTask})的 {@code dsh:votingRule}
     * (2026-09-15 三种 task 统一计票);无 votingRule 元素返回 null。
     * assignmentRule/userPrompt/outputMappings 等对定制 delegate 节点无意义
     * (输出由 delegate 代码 setVariable),只解析计票规则。
     */
    public DshExtensionProperties parsePlainServiceTask(ServiceTask serviceTask) {
        Map<String, List<ExtensionElement>> elements = serviceTask.getExtensionElements();
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        DshExtensionProperties.VotingRule rule = parseVotingRule(elements.get("votingRule"));
        if (rule == null) {
            return null;
        }
        return new DshExtensionProperties(
            null, rule, null, null, null, null, null, null);
    }

    /**
     * 解析 {@code dsh:backendTask} 下的 {@code <dsh:backendProfile url="..."/>} 列表
     * (多实例时第 i 个实例绑定第 i 个 URL)。
     */
    private List<String> parseProfileUrls(ExtensionElement backendTaskElement) {
        List<ExtensionElement> profiles = backendTaskElement.getChildElements().get("backendProfile");
        if (profiles == null || profiles.isEmpty()) {
            return List.of();
        }
        List<String> urls = new ArrayList<>(profiles.size());
        for (ExtensionElement profile : profiles) {
            String url = getAttribute(profile, "url");
            if (url != null && !url.isBlank()) {
                urls.add(url.trim());
            }
        }
        return List.copyOf(urls);
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

    /**
     * 解析 {@code dsh:assignmentRule}(design 2026-09-19 扩展:范围 × 目标角色)。
     *
     * <p>互斥归一化(防御手改 XML 的矛盾配置;严格校验在 web-console 发布层):
     * {@code virtualRole} 非空时忽略 {@code candidateRoleId} / {@code orgScope} /
     * {@code fixedUnitId},归一化为纯虚拟角色配置——虚拟角色本身即在行政线上
     * 相对移动,跨线属性无意义。</p>
     */
    private DshExtensionProperties.AssignmentRule parseAssignmentRule(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        String virtualRole = trimToNull(getAttribute(e, "virtualRole"));
        if (virtualRole != null) {
            return new DshExtensionProperties.AssignmentRule(null, null, virtualRole, null);
        }
        return new DshExtensionProperties.AssignmentRule(
            trimToNull(getAttribute(e, "candidateRoleId")),
            trimToNull(getAttribute(e, "orgScope")),
            null,
            trimToNull(getAttribute(e, "fixedUnitId"))
        );
    }

    private static String trimToNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return value.trim();
    }

    /**
     * 解析 {@code dsh:votingRule}(design 2026-09-15);无元素或必填属性缺失返回 null
     * (合法性由 web-console 发布校验把守,解析层容错)。
     */
    private DshExtensionProperties.VotingRule parseVotingRule(List<ExtensionElement> elements) {
        if (elements == null || elements.isEmpty()) {
            return null;
        }
        ExtensionElement e = elements.get(0);
        String variable = getAttribute(e, "variable");
        String passValue = getAttribute(e, "passValue");
        Integer passCount = parseInteger(getAttribute(e, "passCount"));
        Integer rejectCount = parseInteger(getAttribute(e, "rejectCount"));
        if (variable == null || variable.isBlank()
            || passValue == null || passValue.isBlank() || passCount == null) {
            return null;
        }
        return new DshExtensionProperties.VotingRule(
            variable.trim(), passValue.trim(), passCount, rejectCount);
    }

    private static Integer parseInteger(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Integer.valueOf(value.trim());
        } catch (NumberFormatException e) {
            return null;
        }
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
            getAttribute(e, "escalateToUserId"),
            trimToNull(getAttribute(e, "escalateToVirtualRole")),
            trimToNull(getAttribute(e, "escalateOrgScope")),
            trimToNull(getAttribute(e, "escalateFixedUnitId"))
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
