package com.dsh.console.llm;

import com.dsh.console.security.AuthContext;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.HashMap;
import java.util.Map;

/**
 * 员工推理代理 API。
 * 业务含义:员工端对话的唯一服务端入口;先做额度路由与预留,再转发 New API,最后按实际 usage 结算。
 * 会话标识经 X-DSH-Session-Id 头传入(不进请求体,避免被透传到上游)。
 */
@RestController
@RequestMapping("/api/llm/v1")
@PreAuthorize("isAuthenticated()")
public class LlmProxyController {

    private final LlmProxyService proxyService;

    public LlmProxyController(LlmProxyService proxyService) {
        this.proxyService = proxyService;
    }

    /**
     * OpenAI 兼容对话端点。
     * 算法:请求体 model 字段填企业逻辑模型名(gateway_model_name);stream=true 时走 SSE 透传。
     * 返回类型必须是精确的 ResponseEntity&lt;StreamingResponseBody&gt;:通配符泛型会让
     * StreamingResponseBodyReturnValueHandler 拒收,落到 MessageConverter 路径报
     * "No converter ... with preset Content-Type 'text/event-stream'"。
     */
    @PostMapping("/chat/completions")
    public ResponseEntity<StreamingResponseBody> chatCompletions(@RequestBody Map<String, Object> body,
                                             @RequestHeader(value = "X-DSH-Session-Id", required = false)
                                             String sessionId,
                                             @AuthenticationPrincipal AuthContext auth) {
        Object model = body.get("model");
        if (!(model instanceof String modelName) || modelName.isBlank()) {
            throw new LlmException("LLM_MODEL_REQUIRED", "请求体缺少 model 字段");
        }
        LlmProxyService.Reservation reservation =
            proxyService.reserve(auth.platformUserId(), modelName, sessionId);

        if (Boolean.TRUE.equals(body.get("stream"))) {
            StreamingResponseBody streamBody = out -> proxyService.streamAndSettle(reservation, body, out);
            return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("text/event-stream"))
                .header("Cache-Control", "no-cache")
                .header("X-Accel-Buffering", "no")
                .body(streamBody);
        }

        int[] statusOut = {200};
        Map<String, String> headersOut = new HashMap<>();
        byte[] responseBody = proxyService.callAndSettle(reservation, body, statusOut, headersOut);
        StreamingResponseBody byteBody = out -> out.write(responseBody);
        return ResponseEntity.status(statusOut[0])
            .contentType(MediaType.APPLICATION_JSON)
            .body(byteBody);
    }
}
