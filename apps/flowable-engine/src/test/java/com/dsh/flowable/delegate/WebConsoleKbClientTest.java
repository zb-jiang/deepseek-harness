package com.dsh.flowable.delegate;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.flowable.config.DshWebConsoleProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link WebConsoleKbClient} 服务密钥解析测试:JDK HttpServer 起 stub,断言
 * 200 信封解析、404(未开通)与其他异常状态全部降级为 null(不阻塞任务)、
 * X-Service-Key 头携带、未配置密钥直接降级。
 */
class WebConsoleKbClientTest {

    private HttpServer server;
    private String baseUrl;
    private final ObjectMapper mapper = new ObjectMapper();

    /** stub 收到的 X-Service-Key 头。 */
    private final AtomicReference<String> capturedKey = new AtomicReference<>();

    /** stub 返回状态;非 200 时 body 仍发信封形态。 */
    private volatile int respondStatus = 200;

    /** stub 返回的 data 节点。 */
    private volatile Object responseData = new WebConsoleKbClient.KbRef("kb-1", "差旅知识库");

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        int port = server.getAddress().getPort();
        baseUrl = "http://127.0.0.1:" + port;
        server.createContext("/api/backend/kb/resolve", exchange -> {
            capturedKey.set(exchange.getRequestHeaders().getFirst("X-Service-Key"));
            byte[] bytes = mapper.writeValueAsBytes(
                java.util.Map.of("success", true, "data", responseData));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(respondStatus, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private WebConsoleKbClient client(String serviceKey) {
        return new WebConsoleKbClient(
            new DshWebConsoleProperties(baseUrl, serviceKey), mapper);
    }

    @Test
    void resolvesKbFromEnvelope() {
        WebConsoleKbClient.KbRef kb = client("sk-1").resolveOrNull("expense_flow:3:x", "act-1");
        assertThat(kb).isNotNull();
        assertThat(kb.kbId()).isEqualTo("kb-1");
        assertThat(kb.kbName()).isEqualTo("差旅知识库");
        assertThat(capturedKey.get()).isEqualTo("sk-1");
    }

    @Test
    void notFoundDegradesToNullWithoutThrowing() {
        // 应用未开通知识库(404):正常路径,降级为无 kb
        respondStatus = 404;
        assertThat(client("sk-1").resolveOrNull("expense_flow:3:x", "act-2")).isNull();
    }

    @Test
    void unauthorizedDegradesToNull() {
        // 密钥漂移(401):降级为无 kb 并告警,不阻塞任务
        respondStatus = 401;
        assertThat(client("sk-wrong").resolveOrNull("expense_flow:3:x", "act-3")).isNull();
    }

    @Test
    void blankServiceKeyDegradesWithoutHttpRequest() {
        // 未配置密钥:直接降级,不打 HTTP(web-console 侧 401 也到不了)
        respondStatus = 500; // 若真发出请求,stub 返回 500,结果同为 null,但断言捕获头为 null
        assertThat(client("").resolveOrNull("expense_flow:3:x", "act-4")).isNull();
        assertThat(capturedKey.get()).isNull();
    }

    @Test
    void malformedEnvelopeDegradesToNull() {
        responseData = java.util.Map.of("unrelated", true);
        assertThat(client("sk-1").resolveOrNull("expense_flow:3:x", "act-5")).isNull();
    }

    @Test
    void unreachableHostDegradesToNull() {
        WebConsoleKbClient deadClient = new WebConsoleKbClient(
            new DshWebConsoleProperties("http://127.0.0.1:1", "sk-1"), mapper);
        assertThat(deadClient.resolveOrNull("expense_flow:3:x", "act-6")).isNull();
    }
}
