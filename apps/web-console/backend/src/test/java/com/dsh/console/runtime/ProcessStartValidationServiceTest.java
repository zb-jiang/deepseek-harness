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

/**
 * 严格声明制启动校验的系统注入(initiator)行为测试:声明 source=system 时按登录人
 * 自动注入,调用方传入同名变量拒绝;start-param 常规路径不受影响。
 */
class ProcessStartValidationServiceTest {

    private final ProcessStartValidationService service = new ProcessStartValidationService(
        org.mockito.Mockito.mock(FlowableRestClient.class), new ObjectMapper());

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

    private static ContextVariable variable(String name, String type, String source) {
        return new ContextVariable(name, type, null, null, null, source, List.of());
    }

    private static AuthContext auth(String displayName, String email) {
        return new AuthContext(
            UUID.randomUUID(), "sub-1", email, "zhangsan", displayName, List.of());
    }
}
