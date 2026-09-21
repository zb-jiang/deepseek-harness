package com.dsh.console.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.BpmnContextParser.ContextVariable;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

/**
 * 严格声明制启动校验的系统注入(initiator)行为测试:声明 source=system 时按登录人
 * 自动注入,调用方传入同名变量拒绝;start-param 常规路径不受影响。
 * 组织维度审批路由启动校验(design 2026-09-19 §5.1/§5.3):loadStartContext 解析
 * 同行政线依赖与 resolveApplicantOrgUnit 发起身份分支(0/唯一/多,防伪造)。
 */
class ProcessStartValidationServiceTest {

    private final FlowableRestClient flowableRestClient = Mockito.mock(FlowableRestClient.class);
    private final ProcessStartValidationService service = new ProcessStartValidationService(
        flowableRestClient, new ObjectMapper());

    @Test
    void systemDeclarationInjectsInitiatorFromAuth() {
        List<ContextVariable> declarations = List.of(
            variable("initiator", "object", "system"),
            variable("amount", "string", "start-param"));

        Map<String, Object> result = service.buildVariables(
            declarations, Map.of("amount", "100"), auth("张三", "zhang@corp.com"));

        assertThat(result).containsEntry("amount", "100");
        assertThat(result.get("initiator")).isEqualTo(Map.of(
            "userId", "sub-1",
            "name", "张三",
            "email", "zhang@corp.com"));
    }

    @Test
    void passingSystemVariableIsRejected() {
        List<ContextVariable> declarations = List.of(variable("initiator", "object", "system"));

        assertThatThrownBy(() -> service.buildVariables(
            declarations, Map.of("initiator", Map.of("userId", "forged")), auth("张三", "z")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("系统注入变量")
            .hasMessageContaining("不允许调用方传入");
    }

    @Test
    void displayNameFallsBackToLoginNameThenEmail() {
        List<ContextVariable> declarations = List.of(variable("initiator", "object", "system"));

        Map<String, Object> noDisplayName = service.buildVariables(
            declarations, null, new AuthContext(
                UUID.randomUUID(), "sub-1", "zhang@corp.com", "zhangsan", null, List.of()));
        assertThat(noDisplayName.get("initiator")).isEqualTo(Map.of(
            "userId", "sub-1", "name", "zhangsan", "email", "zhang@corp.com"));

        Map<String, Object> bareSubject = service.buildVariables(
            declarations, null, new AuthContext(
                UUID.randomUUID(), "sub-1", null, null, null, List.of()));
        assertThat(bareSubject.get("initiator")).isEqualTo(Map.of(
            "userId", "sub-1", "name", "sub-1", "email", ""));
    }

    @Test
    void startParamWithoutSystemDeclarationBehavesUnchanged() {
        List<ContextVariable> declarations = List.of(
            variable("amount", "integer", "start-param"));

        Map<String, Object> result = service.buildVariables(
            declarations, Map.of("amount", 100), auth("张三", "z"));

        assertThat(result).containsEntry("amount", 100L);
    }

    // ===== 组织维度审批路由启动校验(design 2026-09-19 §5.1/§5.3) =====

    @Test
    void loadStartContextRequiresApplicantOrgUnitForSameLineAndVirtualRole() {
        Mockito.when(flowableRestClient.getProcessDefinitionBpmnXml("procdef-1")).thenReturn("""
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="org_start_test" isExecutable="true">
                <extensionElements>
                  <dsh:contextVariables>
                    <dsh:contextVariable name="amount" type="string" source="start-param"/>
                  </dsh:contextVariables>
                </extensionElements>
                <startEvent id="start"/>
                <userTask id="task" name="上级审批">
                  <extensionElements>
                    <dsh:assignmentRule virtualRole="parent"/>
                  </extensionElements>
                </userTask>
                <userTask id="task2" name="同线财务">
                  <extensionElements>
                    <dsh:assignmentRule candidateRoleId="role-1" orgScope="sameLine"/>
                  </extensionElements>
                </userTask>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="task2"/>
                <endEvent id="end"/>
              </process>
            </definitions>""");

        ProcessStartValidationService.StartContext context = service.loadStartContext("procdef-1");

        assertThat(context.requiresApplicantOrgUnit()).isTrue();
        assertThat(context.declarations())
            .extracting(ContextVariable::name)
            .containsExactly("amount");
    }

    @Test
    void loadStartContextWithoutSameLineRulesRequiresNothing() {
        // global 实体角色 / fixedUnit 指定部门 / 存量无规则节点都不依赖申请人行政线
        Mockito.when(flowableRestClient.getProcessDefinitionBpmnXml("procdef-2")).thenReturn("""
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="plain_start_test" isExecutable="true">
                <startEvent id="start"/>
                <userTask id="task" name="全局角色">
                  <extensionElements>
                    <dsh:assignmentRule candidateRoleId="role-1" orgScope="global"/>
                  </extensionElements>
                </userTask>
                <userTask id="task2" name="指定部门">
                  <extensionElements>
                    <dsh:assignmentRule candidateRoleId="role-1" orgScope="fixedUnit"
                                        fixedUnitId="11111111-1111-1111-1111-111111111111"/>
                  </extensionElements>
                </userTask>
                <userTask id="task3" name="存量节点"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="task2"/>
                <sequenceFlow id="flow3" sourceRef="task2" targetRef="task3"/>
                <endEvent id="end"/>
              </process>
            </definitions>""");

        ProcessStartValidationService.StartContext context = service.loadStartContext("procdef-2");

        assertThat(context.requiresApplicantOrgUnit()).isFalse();
        assertThat(context.declarations()).isEmpty();
    }

    @Test
    void resolveApplicantOrgUnitRejectsMissingDepartmentForSameLine() {
        ProcessStartValidationService.StartContext requires =
            new ProcessStartValidationService.StartContext(List.of(), true);

        assertThatThrownBy(() -> service.resolveApplicantOrgUnit(requires, List.of(), null))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("申请人尚未分配部门");

        // 无归属但请求伪造身份 → 拒绝
        assertThatThrownBy(() -> service.resolveApplicantOrgUnit(
            requires, List.of(), UUID.randomUUID()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("与申请人所属部门不符");
    }

    @Test
    void resolveApplicantOrgUnitPassesWithoutMembershipWhenNotRequired() {
        // 流程不依赖行政线时,申请人无部门照常启动(第四变量不注入,返回 null)
        ProcessStartValidationService.StartContext notRequired =
            new ProcessStartValidationService.StartContext(List.of(), false);

        assertThat(service.resolveApplicantOrgUnit(notRequired, List.of(), null)).isNull();
    }

    @Test
    void resolveApplicantOrgUnitAdoptsSingleMembershipAutomatically() {
        UUID only = UUID.randomUUID();
        assertThat(service.resolveApplicantOrgUnit(
            new ProcessStartValidationService.StartContext(List.of(), true),
            List.of(only), null)).isEqualTo(only);

        // 传了必须匹配,不匹配拒绝(防伪造)
        assertThatThrownBy(() -> service.resolveApplicantOrgUnit(
            new ProcessStartValidationService.StartContext(List.of(), false),
            List.of(only), UUID.randomUUID()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("不在申请人所属部门列表中");
    }

    @Test
    void resolveApplicantOrgUnitRequiresSelectionForMultipleMemberships() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        ProcessStartValidationService.StartContext ctx =
            new ProcessStartValidationService.StartContext(List.of(), true);

        // 多身份未选 → 拒绝
        assertThatThrownBy(() -> service.resolveApplicantOrgUnit(ctx, List.of(a, b), null))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("请选择发起身份");

        // 选了列表中的身份 → 采纳
        assertThat(service.resolveApplicantOrgUnit(ctx, List.of(a, b), b)).isEqualTo(b);

        // 伪造不在列表中的身份 → 拒绝
        assertThatThrownBy(() -> service.resolveApplicantOrgUnit(
            ctx, List.of(a, b), UUID.randomUUID()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("不在申请人所属部门列表中");
    }

    private static ContextVariable variable(String name, String type, String source) {
        return new ContextVariable(name, type, null, null, null, source, List.of());
    }

    private static AuthContext auth(String displayName, String email) {
        return new AuthContext(
            UUID.randomUUID(), "sub-1", email, "zhangsan", displayName, List.of());
    }
}
