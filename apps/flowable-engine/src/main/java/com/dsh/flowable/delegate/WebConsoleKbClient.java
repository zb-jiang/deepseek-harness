package com.dsh.flowable.delegate;

import com.dsh.flowable.config.DshWebConsoleProperties;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * web-console 服务密钥客户端(2026-10 知识库集成):backend task 提交前按流程
 * 定义解析所属工程的知识库。
 *
 * <p>调用形态:X-Service-Key 头 + {@code GET {baseUrl}/api/backend/kb/resolve},
 * 响应为 web-console ApiResponse 信封 {@code {success, data:{kbId, kbName}}}。
 *
 * <p>失败语义(知识库是可选增强,不阻塞任务):应用未开通知识库(404)返回
 * 空属正常;密钥未配/网络失败/信封异常降级为空并 WARN 告警——连续出现说明
 * 配置漂移,须人工修复;不抛异常以免流程卡死在重试上。
 */
@Component
public class WebConsoleKbClient {

    private static final Logger log = LoggerFactory.getLogger(WebConsoleKbClient.class);

    /** 解析出的任务知识库:payload 字段与 kb 上下文注入共用。 */
    public record KbRef(String kbId, String kbName) {
    }

    private final DshWebConsoleProperties properties;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public WebConsoleKbClient(DshWebConsoleProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.restTemplate = new RestTemplate();
    }

    /**
     * 解析流程归属工程的知识库;任何失败路径都返回 null(日志说明原因)。
     *
     * @param processDefinitionId Flowable procdef id({@code key:version:uuid})
     * @param activityId          节点 id(日志定位)
     * @return 知识库引用;未开通/降级时 null
     */
    public KbRef resolveOrNull(String processDefinitionId, String activityId) {
        String serviceKey = properties.serviceKey();
        if (serviceKey == null || serviceKey.isBlank()) {
            log.warn("[DSH backend] 未配置 dsh.web-console.service-key,本任务不启用知识库: activity={}",
                activityId);
            return null;
        }
        String url = properties.baseUrl() + "/api/backend/kb/resolve?processDefinitionId="
            + URLEncoder.encode(processDefinitionId, StandardCharsets.UTF_8);
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Service-Key", serviceKey);
        ResponseEntity<String> response;
        try {
            response = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
        } catch (RuntimeException e) {
            log.warn("[DSH backend] 知识库解析失败,本任务不启用知识库: activity={}, url={}, error={}",
                activityId, url, e.getMessage());
            return null;
        }
        int status = response.getStatusCode().value();
        if (status == 404) {
            // 应用未开通知识库:正常路径,不告警
            log.info("[DSH backend] 流程所属应用未开通知识库,本任务不注入: activity={}", activityId);
            return null;
        }
        if (status != 200 || response.getBody() == null) {
            // 密钥不符(401)或 web-console 内部错误:配置漂移信号,持续出现须人工修复
            log.warn("[DSH backend] 知识库解析返回异常状态,本任务不启用知识库: activity={}, status={}, url={}",
                activityId, status, url);
            return null;
        }
        try {
            JsonNode envelope = objectMapper.readTree(response.getBody());
            JsonNode data = envelope.path("data");
            String kbId = data.path("kbId").asText("");
            String kbName = data.path("kbName").asText("");
            if (kbId.isBlank()) {
                log.warn("[DSH backend] 知识库解析响应缺 kbId: activity={}, body={}",
                    activityId, response.getBody());
                return null;
            }
            return new KbRef(kbId, kbName);
        } catch (RuntimeException | JsonProcessingException e) {
            log.warn("[DSH backend] 知识库解析响应解析失败: activity={}, error={}", activityId, e.getMessage());
            return null;
        }
    }
}
