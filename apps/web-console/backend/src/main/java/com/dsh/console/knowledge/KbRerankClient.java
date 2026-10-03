package com.dsh.console.knowledge;

import com.dsh.console.config.KnowledgeProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * rerank 客户端:检索管线把 RRF 融合后的候选文本送到 rerank 供应商的 cohere 风格端点
 * {@code POST {base}/rerank}(基址/密钥独立于 embedding 配置,默认同为硅基流动,
 * 不经 New API、不计员工额度),返回每个候选与查询的相关性分(0~1,越大越相关;
 * cross-encoder 输出,无关对贴近 0)。
 *
 * <p>请求 {@code {model, query, documents}};响应 {@code results[].{index, relevance_score}}
 * 按分数降序,由调用方按 {@code index}(对应 documents 下标)对齐回原顺序。响应可能
 * 携带 {@code document} 原文字段,此处不消费。任一候选缺分或 index 越界视为响应不合法,
 * 整批抛出,由调用方降级为 RRF 排序(检索主路径不被增强组件绑架)。
 */
@Component
public class KbRerankClient {

    private final KnowledgeProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public KbRerankClient(KnowledgeProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(properties.embeddingConnectTimeout())
            .build();
    }

    /**
     * 对候选文本逐个打相关性分。
     *
     * @param query     查询原文
     * @param documents 候选文本(文档名 + 摘录组合)
     * @return 与 documents 顺序一一对应的相关性分(0~1)
     * @throws IOException 网关不可达 / 响应不合法(消息含原因,调用方降级并告警)
     */
    public List<Double> rerank(String query, List<String> documents)
            throws IOException, InterruptedException {
        String body;
        try {
            body = objectMapper.writeValueAsString(Map.of(
                "model", properties.rerankModel(),
                "query", query,
                "documents", documents));
        } catch (Exception e) {
            throw new IOException("rerank 请求体序列化失败: " + e.getMessage());
        }
        HttpRequest request = HttpRequest.newBuilder()
            .uri(rerankUri())
            .header("Authorization", "Bearer " + properties.rerankApiKey())
            .header("Content-Type", "application/json")
            .timeout(properties.embeddingResponseTimeout())
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("rerank 网关返回 HTTP " + response.statusCode()
                + " (" + request.uri() + "): " + abbreviate(response.body()));
        }
        JsonNode root = parse(response.body());
        JsonNode results = root != null ? root.get("results") : null;
        if (results == null || !results.isArray() || results.size() != documents.size()) {
            throw new IOException("rerank 响应缺少与请求数量一致的 results 数组");
        }
        // 按 index 放回原顺序:results 按分数降序,index 指向请求 documents 下标,
        // 是对齐的唯一依据(cohere 风格契约),越界或重复即响应不合法
        Double[] scores = new Double[documents.size()];
        for (JsonNode item : results) {
            JsonNode indexNode = item.get("index");
            JsonNode scoreNode = item.get("relevance_score");
            if (indexNode == null || scoreNode == null) {
                throw new IOException("rerank 响应缺少 index 或 relevance_score 字段");
            }
            int index = indexNode.asInt(-1);
            if (index < 0 || index >= scores.length || scores[index] != null) {
                throw new IOException("rerank 响应 index 越界或重复: " + index);
            }
            scores[index] = scoreNode.asDouble();
        }
        List<Double> ordered = new ArrayList<>(documents.size());
        for (Double score : scores) {
            ordered.add(score);
        }
        return ordered;
    }

    /**
     * rerank 端点 URI:独立基址(默认与 embedding 同为硅基流动),去尾斜杠后拼路径。
     */
    private URI rerankUri() {
        String base = properties.rerankApiUrl();
        String trimmed = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        return URI.create(trimmed + "/rerank");
    }

    private JsonNode parse(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            return null;
        }
    }

    private static String abbreviate(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= 500 ? text : text.substring(0, 500);
    }
}
