package com.dsh.flowable.delegate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.flowable.config.DshBackendProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link DshBackendClient} 的提交+轮询协议测试:JDK 内置 HttpServer 起 stub
 * 端点(POST /api/backend/tasks → 202 taskId;GET /api/backend/tasks/{taskId}
 * 按 stub 状态机返回 running/ready/failed),断言轮询逻辑、result 提取容错
 * (首末花括号)、失败与超时语义(design 2026-09-14 §6.2)。
 */
class DshBackendClientTest {

    private HttpServer server;
    private String baseUrl;
    private final ObjectMapper mapper = new ObjectMapper();

    /** stub 状态:轮询次数(每次 GET 递增)。 */
    private final AtomicInteger pollCount = new AtomicInteger();

    /** ready 任务的 result 字段内容;测试用例按需覆盖。 */
    private volatile Object readyResult = Map.of("status", "ok");

    /** POST 提交的请求体(测试断言 prompt/skillRefs 的 UTF-8 往返)。 */
    private volatile Map<String, Object> submittedBody;

    /** failed 任务的 error 文本;非 null 时 GET 返回 failed。 */
    private volatile String failedError;

    /** running 轮询几次后转 ready;0 表示第一次即 ready。 */
    private volatile int runningRounds;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        int port = server.getAddress().getPort();
        baseUrl = "http://127.0.0.1:" + port;
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if ("POST".equals(method) && path.equals("/api/backend/tasks")) {
                submittedBody = mapper.readValue(
                    exchange.getRequestBody().readAllBytes(),
                    new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
                respond(exchange, 202, Map.of("taskId", "t-1"));
            } else if ("GET".equals(method) && path.equals("/api/backend/tasks/t-1")) {
                if (failedError != null) {
                    respond(exchange, 200, Map.of("status", "failed", "error", failedError));
                } else if (pollCount.getAndIncrement() < runningRounds) {
                    respond(exchange, 200, Map.of("status", "running"));
                } else {
                    respond(exchange, 200, Map.of("status", "ready", "result", readyResult));
                }
            } else {
                respond(exchange, 404, Map.of("error", "unexpected " + method + " " + path));
            }
        });
        server.start();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private void respond(com.sun.net.httpserver.HttpExchange exchange, int status, Object body)
            throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private DshBackendClient client(long pollIntervalSeconds, long callTimeoutSeconds) {
        return new DshBackendClient(
            new DshBackendProperties(pollIntervalSeconds, callTimeoutSeconds), mapper);
    }

    @Test
    void submitsThenPollsUntilReadyAndReturnsResult() {
        runningRounds = 1;
        Map<String, Object> result = client(1, 10).execute(
            baseUrl, "生成摘要", List.of("skill-a"), "act-1");
        assertThat(result).containsEntry("status", "ok");
        assertThat(pollCount.get()).isEqualTo(2);
    }

    @Test
    void failedTaskThrowsWithBackendErrorText() {
        failedError = "模型输出中不含合法 JSON 对象";
        assertThatThrownBy(() -> client(1, 10).execute(
            baseUrl, "任意", List.of(), "act-2"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("模型输出中不含合法 JSON 对象");
    }

    @Test
    void callTimeoutThrows() {
        // 一直 running,callTimeout 2 秒(pollInterval 1 秒 → 两次轮询后超时)
        runningRounds = Integer.MAX_VALUE;
        assertThatThrownBy(() -> client(1, 2).execute(
            baseUrl, "任意", List.of(), "act-3"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("轮询超时");
    }

    @Test
    void stringResultExtractedBetweenFirstAndLastBraces() {
        // 防御:profile 契约 result 是 JSON 对象,但字符串形态(包了说明文字)
        // 按首末花括号容错提取
        readyResult = "前缀说明 {\"x\": 1, \"y\": [2, 3]} 后缀说明";
        Map<String, Object> result = client(1, 10).execute(
            baseUrl, "任意", List.of(), "act-4");
        assertThat(result).containsEntry("x", 1);
    }

    @Test
    void nonObjectResultRejected() {
        readyResult = 42;
        assertThatThrownBy(() -> client(1, 10).execute(
            baseUrl, "任意", List.of(), "act-5"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("不是 JSON 对象");
    }

    @Test
    void connectionRefusedFailsLoud() {
        // 未监听端口:提交立即抛 IllegalStateException
        String deadUrl = "http://127.0.0.1:1";
        assertThatThrownBy(() -> client(1, 2).execute(
            deadUrl, "任意", List.of(), "act-6"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("提交失败");
    }

    @Test
    void requestCarriesPromptAndSkillRefsUtf8() {
        runningRounds = 0;
        // 中文与 skill 清单经 JSON UTF-8 提交;乱码(PS5.1 Latin-1 那类)会在
        // stub 的 Jackson 解析层抛错,submit 失败
        Map<String, Object> result = client(1, 10).execute(
            baseUrl, "生成「中文」摘要", List.of("skill-a", "skill-b"), "act-7");
        assertThat(result).containsEntry("status", "ok");
        assertThat(submittedBody).containsEntry("prompt", "生成「中文」摘要");
        assertThat(submittedBody.get("skillRefs"))
            .isEqualTo(List.of("skill-a", "skill-b"));
    }
}
