package com.dsh.console.knowledge;

import com.dsh.console.config.KnowledgeProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * embedding 客户端:解析管线把 chunk 文本批量送到硅基流动 OpenAI 兼容端点
 * {@code POST {base}/embeddings}(独立 API Key,Bearer 鉴权;系统行为不经 New API、不计员工额度),
 * 返回向量按请求顺序对齐。
 *
 * <p>请求体带 {@code dimensions} 钉死输出宽度(Qwen3-Embedding 系列支持 MRL 自定义维度,
 * 上限因模型而异:4B 为 2560),响应侧再校验实际维度与配置一致,两端兜住「配置与
 * halfvec(N) 列不符」的错配。单文档可能产出上百 chunk,
 * 按 {@link #BATCH_SIZE} 分批串行调用;任一批失败抛出,由管线把整篇文档标记 failed
 * (未完成文档不进检索),重新解析可恢复。
 */
@Component
public class KbEmbeddingClient {

    private static final Logger log = LoggerFactory.getLogger(KbEmbeddingClient.class);

    /** 单批 chunk 数:分批上限(批次过大易触发上游限流/超时)。 */
    private static final int BATCH_SIZE = 16;

    private final KnowledgeProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public KbEmbeddingClient(KnowledgeProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(properties.embeddingConnectTimeout())
            .build();
    }

    /**
     * 批量生成 embedding。
     *
     * @param texts chunk 文本列表(按文档内顺序)
     * @return 向量列表(与输入一一对应;fp16 精度由 PG halfvec 列存储时收敛)
     * @throws IOException 网关不可达 / 响应不合法 / 维度与配置不符(消息含原因,写入 parse_error)
     */
    public List<List<Float>> embed(List<String> texts) throws IOException, InterruptedException {
        List<List<Float>> result = new ArrayList<>(texts.size());
        for (int start = 0; start < texts.size(); start += BATCH_SIZE) {
            List<String> batch = texts.subList(start, Math.min(start + BATCH_SIZE, texts.size()));
            result.addAll(embedBatch(batch));
        }
        return result;
    }

    /**
     * 向量转 halfvec 文本格式(pgvector 输入格式 {@code [v1,v2,...]};十进制文本由 PG 转半精度存储)。
     */
    public static String toHalfvecLiteral(List<Float> vector) {
        StringBuilder sb = new StringBuilder(vector.size() * 10 + 2);
        sb.append('[');
        for (int i = 0; i < vector.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(BigDecimal.valueOf(vector.get(i)).setScale(6, RoundingMode.HALF_UP)
                .stripTrailingZeros().toPlainString());
        }
        sb.append(']');
        return sb.toString();
    }

    private List<List<Float>> embedBatch(List<String> batch)
            throws IOException, InterruptedException {
        String body;
        try {
            body = objectMapper.writeValueAsString(java.util.Map.of(
                "model", properties.embeddingModel(),
                "input", batch,
                "dimensions", properties.embeddingDimensions()));
        } catch (Exception e) {
            throw new IOException("embedding 请求体序列化失败: " + e.getMessage());
        }
        HttpRequest request = HttpRequest.newBuilder()
            .uri(embeddingsUri())
            .header("Authorization", "Bearer " + properties.embeddingApiKey())
            .header("Content-Type", "application/json")
            .timeout(properties.embeddingResponseTimeout())
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            // 带上实际请求 URL:404 常见于把 API_URL 配成完整端点(多了 /embeddings)或缺 /v1
            throw new IOException("embedding 网关返回 HTTP " + response.statusCode()
                + " (" + request.uri() + "): " + abbreviate(response.body()));
        }
        JsonNode root = parse(response.body());
        JsonNode data = root != null ? root.get("data") : null;
        if (data == null || !data.isArray() || data.size() != batch.size()) {
            throw new IOException("embedding 响应缺少与请求数量一致的 data 数组");
        }
        List<List<Float>> vectors = new ArrayList<>(batch.size());
        for (JsonNode item : data) {
            JsonNode embedding = item.get("embedding");
            if (embedding == null || !embedding.isArray() || embedding.size() != properties.embeddingDimensions()) {
                throw new IOException("embedding 维度(" + (embedding == null ? 0 : embedding.size())
                    + ")与配置 " + properties.embeddingDimensions() + " 不符,"
                    + "请对齐 KB_EMBEDDING_DIMENSIONS 与 kb_chunks.embedding 列定义");
            }
            List<Float> vector = new ArrayList<>(embedding.size());
            for (JsonNode value : embedding) {
                vector.add((float) value.asDouble());
            }
            vectors.add(vector);
        }
        // 按响应自然顺序对齐:OpenAI 兼容网关按 input 顺序返回 data;
        // SiliconFlow 的 VL embedding 响应 index 恒为 0(不可信),不做 index 重排,
        // 仅在 index 序列与顺序明显不符时告警,便于发现真正乱序的网关实现
        for (int i = 0; i < data.size(); i++) {
            JsonNode indexNode = data.get(i).get("index");
            if (indexNode != null && indexNode.asInt(-1) != i) {
                log.warn("embedding 响应第 {} 项 index={} 与顺序不符,按响应顺序对齐", i, indexNode.asInt());
                break;
            }
        }
        return vectors;
    }

    /**
     * embeddings 端点 URI:基址去尾斜杠后拼路径(配置值由启动校验保证非空)。
     */
    private URI embeddingsUri() {
        String base = properties.embeddingApiUrl();
        String trimmed = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        return URI.create(trimmed + "/embeddings");
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
