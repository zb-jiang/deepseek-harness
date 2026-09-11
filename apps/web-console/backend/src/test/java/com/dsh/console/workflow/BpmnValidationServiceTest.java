package com.dsh.console.workflow;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.role.AppRoleJdbcRepository;
import com.dsh.console.skillhub.SkillHubRestClient;
import com.dsh.console.skillhub.dto.SkillHubSkillDto;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Process Context 发布校验五查中 system 声明相关的规则测试:
 * initiator 结构精确校验、输出映射 target 禁改、来源闭环把 system 计入来源;
 * 以及 skillRef 引用存在性校验(SkillHub namespace 绑定)。
 */
class BpmnValidationServiceTest {

    private BpmnValidationService service;
    private ApplicationJdbcRepository appRepository;
    private SkillHubRestClient skillHubRestClient;

    @BeforeEach
    void setUp() {
        AppRoleJdbcRepository roleRepository = mock(AppRoleJdbcRepository.class);
        when(roleRepository.listByApp(any(UUID.class))).thenReturn(List.of());
        appRepository = mock(ApplicationJdbcRepository.class);
        skillHubRestClient = mock(SkillHubRestClient.class);
        service = new BpmnValidationService(roleRepository, appRepository, skillHubRestClient);
    }

    @Test
    void standardInitiatorDeclarationPassesWithPromptAndConditionReferences() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
                <dsh:field name="email" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, """
            <dsh:userPrompt text="你当前的申请人为{{initiator.name}}"/>
            """, "${initiator.userId == 'sub-1'}"), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void systemSourceOnlySupportsInitiator() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="operator" type="object" source="system"/>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("仅支持 initiator"));
    }

    @Test
    void initiatorMustBeObjectType() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="string" source="system"/>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("必须为 object 类型"));
    }

    @Test
    void initiatorFieldsMustBeExactlyUserIdNameEmail() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("userId/name/email"))
            .anyMatch(e -> e.contains("initiator"));
    }

    @Test
    void outputMappingTargetToSystemVariableIsRejected() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
                <dsh:field name="email" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, """
            <dsh:userPrompt text="确认"/>
            <dsh:outputMappings>
              <dsh:mapping source="applicant" target="initiator"/>
            </dsh:outputMappings>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("指向系统注入变量"));
    }

    @Test
    void promptReferencingInitiatorWithoutDeclarationFails() {
        BpmnValidationResult result = service.validate(bpmn(
            "", """
            <dsh:userPrompt text="你当前的申请人为{{initiator.name}}"/>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("引用未声明变量: initiator"));
    }

    // ===== skillRef 引用存在性(SkillHub namespace 绑定) =====

    @Test
    void skillRefWithoutBoundNamespaceFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(null)));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("未绑定 SkillHub namespace"));
    }

    @Test
    void skillRefNotInPublishedListFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app("enterprise")));
        when(skillHubRestClient.listNamespaceSkills("enterprise")).thenReturn(List.of(
            new SkillHubSkillDto("other-skill", "1.0.0", "其他技能", "2026-09-01T00:00:00Z")));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("已发布清单"))
            .anyMatch(e -> e.contains("approval-helper"));
    }

    @Test
    void noSkillRefSkipsSkillHubValidation() {
        // 无 skillRef 时未绑 namespace 也不报错(不触发 SkillHub 校验)
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(null)));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:userPrompt text="确认"/>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void skillHubUnavailableFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app("enterprise")));
        when(skillHubRestClient.listNamespaceSkills("enterprise"))
            .thenThrow(new IllegalStateException("dsh.skillhub.api-token 未配置"));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("SkillHub 不可达或未配置"));
    }

    /** 构造仅含 skillhubNamespace 的应用 DTO(其余字段与 skillRef 校验无关)。 */
    private static ApplicationDto app(String skillhubNamespace) {
        return new ApplicationDto(null, "app", null, null, skillhubNamespace,
            "active", List.of(), null, null, null, null);
    }

    /**
     * 构造最小合法 BPMN:context 声明 + userTask(prompt/映射)+ 可选条件表达式。
     *
     * @param contextVariablesXml dsh:contextVariables 内部内容(含容器则传空串)
     * @param userTaskExtensions   userTask 的 dsh: 扩展元素(模板统一包 extensionElements)
     * @param conditionExpression sequenceFlow 条件表达式;null 表示无条件
     */
    private String bpmn(String contextVariablesXml, String userTaskExtensions,
                       String conditionExpression) {
        String contextBlock = contextVariablesXml.isBlank() ? "" : """
              <extensionElements>
            %s
              </extensionElements>""".formatted(contextVariablesXml);
        String flow1 = conditionExpression == null
            ? "<sequenceFlow id=\"flow1\" sourceRef=\"start\" targetRef=\"task\"/>"
            : """
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task">
                  <conditionExpression>%s</conditionExpression>
                </sequenceFlow>""".formatted(conditionExpression);
        String taskBlock = userTaskExtensions.isBlank() ? "" : """
                  <extensionElements>
            %s
                  </extensionElements>""".formatted(userTaskExtensions);
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="validation_test_process" isExecutable="true">
            %s
                <startEvent id="start"/>
            %s
                <userTask id="task" name="任务">
            %s
                </userTask>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end"/>
              </process>
            </definitions>""".formatted(contextBlock, flow1, taskBlock);
    }
}
