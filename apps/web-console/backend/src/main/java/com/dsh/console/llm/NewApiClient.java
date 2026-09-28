package com.dsh.console.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * New API 模型清单客户端。
 * 业务含义:用推理转发同一 serviceToken 调 New API 的 OpenAI 兼容端点 GET /v1/models,
 * 拉取该令牌可路由的模型名集合。这是网关模型名的唯一合法取值源——模型清单只定义在 New API,
 * 本地只引用;清单按转发令牌的分组生成,与转发可达范围天然一致。
 */
@Component
public class NewApiClient {

    private final NewApiProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public NewApiClient(NewApiProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    }

    /**
     * 拉取 New API 模型名清单(GET /v1/models)。
     * 算法:解析 OpenAI /v1/models 响应的 data[].id,去重排序;
     * serviceToken 缺失或 New API 不可达时抛 LlmException,调用方按错误码阻塞保存,不静默降级。
     */
    public List<String> listModelNames() {
        if (properties.serviceToken() == null || properties.serviceToken().isBlank()) {
            throw new LlmException("LLM_NEWAPI_UNCONFIGURED",
                "未配置 NEWAPI_SERVICE_TOKEN,无法获取 New API 模型清单", 503);
        }
        HttpRequest request;
        try {
            request = HttpRequest.newBuilder()
                .uri(URI.create(properties.baseUrl() + "/v1/models"))
                .header("Authorization", "Bearer " + properties.serviceToken())
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();
        } catch (IllegalArgumentException e) {
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE",
                "New API 地址非法: " + properties.baseUrl(), 502);
        }
        HttpResponse<String> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE",
                "New API 调用失败: " + e.getMessage(), 502);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE", "调用被中断", 502);
        }
        if (response.statusCode() != 200) {
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE",
                "New API 模型清单接口返回 HTTP " + response.statusCode(), 502);
        }
        return parseModelNames(response.body());
    }

    private List<String> parseModelNames(String body) {
        JsonNode root;
        try {
            root = objectMapper.readTree(body);
        } catch (IOException e) {
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE", "New API 模型清单响应解析失败", 502);
        }
        JsonNode data = root == null ? null : root.path("data");
        if (data == null || !data.isArray()) {
            throw new LlmException("LLM_NEWAPI_UNAVAILABLE", "New API 模型清单响应格式异常", 502);
        }
        List<String> names = new ArrayList<>();
        for (JsonNode item : data) {
            String id = item.path("id").asText(null);
            if (id != null && !id.isBlank()) {
                names.add(id);
            }
        }
        return names.stream().distinct().sorted().toList();
    }
}
