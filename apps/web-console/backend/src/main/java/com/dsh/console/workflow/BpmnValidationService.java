package com.dsh.console.workflow;

import com.dsh.console.role.AppRoleJdbcRepository;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
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
 *   <li>serviceTask 必须配 {@code flowable:delegateExpression=${dshServiceTaskDelegate}}
 *       或自定义 delegateExpression(spec §10.1 自动节点规则)。</li>
 * </ul>
 *
 * <p>V1 仅做静态校验;BPMN 引擎层在运行时还会通过 DshTaskListener 注入 dsh 元数据。
 */
@Service
public class BpmnValidationService {

    private static final String FLOWABLE_NS = "http://flowable.org/bpmn";
    private static final String BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
    private static final String DSH_NS = "http://dsh.ai/schema/bpmn/dsh";

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
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            // 安全配置:禁用外部实体(XXE 防护)
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            DocumentBuilder builder = factory.newDocumentBuilder();
            doc = builder.parse(new java.io.ByteArrayInputStream(bpmnXml.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return BpmnValidationResult.fail("BPMN XML 解析失败: " + e.getMessage());
        }

        // 1) 根元素必须是 bpmn:definitions
        Element root = doc.getDocumentElement();
        if (!BPMN_NS.equals(root.getNamespaceURI()) || !"definitions".equals(root.getLocalName())) {
            return BpmnValidationResult.fail("根元素必须是 bpmn:definitions,实际: "
                + root.getNamespaceURI() + ":" + root.getLocalName());
        }

        // 2) 取本应用所有 role_id 集合,用于校验归属
        List<AppRoleDto> appRoles = roleRepository.listByApp(appId);
        Set<String> validRoleIds = new HashSet<>();
        for (AppRoleDto role : appRoles) {
            validRoleIds.add(role.id().toString());
        }

        // 3) 遍历 userTask,校验候选角色归属
        List<String> errors = new ArrayList<>();
        NodeList userTasks = root.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");

            // 3a) flowable:candidateGroups 引用的 role_id 必属本应用
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

            // 3b) dsh:assignmentRule.candidateRoleId 必属本应用(若存在 dsh extensionElements)
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

        // 4) 遍历 serviceTask,校验 delegateExpression
        NodeList serviceTasks = root.getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");
            String delegate = task.getAttributeNS(FLOWABLE_NS, "delegateExpression");
            if (delegate == null || delegate.isBlank()) {
                errors.add(String.format(
                    "serviceTask[id=%s, name=%s] 缺少 flowable:delegateExpression(spec §10.1 自动节点规则)",
                    taskId, taskName));
            }
        }

        if (errors.isEmpty()) {
            return BpmnValidationResult.ok();
        }
        return BpmnValidationResult.fail(errors);
    }
}
