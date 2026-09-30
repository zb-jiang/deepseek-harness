package com.dsh.console.llm;

import com.dsh.console.llm.dto.EnterpriseModelDto;
import com.dsh.console.llm.dto.QuotaGrantDto;
import com.dsh.console.llm.dto.UserModelRouteDto;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 员工推理代理与额度控制。
 * 业务含义:员工端对话的唯一服务端入口。先按路由链做额度预留,再用内部服务令牌转发到 New API,
 * 最后按实际 usage 结算。员工端永远接触不到上游真实密钥。
 * 并发约束:预留与结算都在事务内经余额行锁完成;释放与结算是幂等的(按 requestId 锁账本行)。
 */
@Service
public class LlmProxyService {

    private static final DateTimeFormatter MONTH_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM");

    /**
     * 一次成功的额度预留。
     * 业务含义:reserve 阶段产出,转发与结算阶段使用;overagePath=true 表示本次走软提醒兜底来源。
     */
    public record Reservation(
        String requestId,
        String usageMonth,
        EnterpriseModelDto model,
        UserModelRouteDto.RouteItemDto chosenItem,
        long reservedTokens,
        boolean overagePath
    ) {}

    private final LlmCatalogJdbcRepository catalogRepository;
    private final LlmQuotaJdbcRepository quotaRepository;
    private final LlmLedgerJdbcRepository ledgerRepository;
    private final NewApiProperties newApiProperties;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactionTemplate;
    private final HttpClient httpClient;

    public LlmProxyService(LlmCatalogJdbcRepository catalogRepository,
                           LlmQuotaJdbcRepository quotaRepository,
                           LlmLedgerJdbcRepository ledgerRepository,
                           NewApiProperties newApiProperties,
                           ObjectMapper objectMapper,
                           TransactionTemplate transactionTemplate) {
        this.catalogRepository = catalogRepository;
        this.quotaRepository = quotaRepository;
        this.ledgerRepository = ledgerRepository;
        this.newApiProperties = newApiProperties;
        this.objectMapper = objectMapper;
        this.transactionTemplate = transactionTemplate;
        // connectTimeout:上游不可达时快速失败,不让调用线程挂在 TCP 握手上
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(newApiProperties.connectTimeout())
            .build();
    }

    // ---------- 预留 ----------

    /**
     * 额度路由与预留。
     * 算法:按路由顺位依次检查"当月 grant 存在 且 余额行 available >= 预留量",命中即锁行占用;
     * 全部不足时,block 直接记 blocked 账本并拒绝,allow_overage 用最后一个有效顺位兜底放行。
     */
    @Transactional
    public Reservation reserve(UUID userId, String gatewayModelName, String sessionId) {
        EnterpriseModelDto model = catalogRepository.findEnabledModelByGatewayName(gatewayModelName)
            .orElseThrow(() -> new LlmException("LLM_MODEL_NOT_FOUND",
                "模型不存在或未启用: " + gatewayModelName, 404));
        UserModelRouteDto route = quotaRepository.findRouteByUserAndModel(userId, model.id())
            .orElseThrow(() -> new LlmException("LLM_ROUTE_NOT_CONFIGURED",
                "该模型未配置额度路由,请联系管理员", 403));

        String month = YearMonth.now().format(MONTH_FORMAT);
        LocalDate today = LocalDate.now();
        long need = model.reservationTokens();
        String requestId = UUID.randomUUID().toString();

        UserModelRouteDto.RouteItemDto chosen = null;
        UserModelRouteDto.RouteItemDto lastEnabledItem = null;
        for (UserModelRouteDto.RouteItemDto item : route.items()) {
            if (!item.enabled()) {
                continue;
            }
            lastEnabledItem = item;
            var grant = quotaRepository.findEffectiveGrant(item.sourceType(), item.sourceId(),
                model.id(), today);
            if (grant.isEmpty()) {
                continue;
            }
            var balance = quotaRepository.lockOrCreateBalance(month, item.sourceType(),
                item.sourceId(), model.id(), grant.get().monthlyLimitTokens());
            long available = balance.limitTokens() - balance.consumedTokens() - balance.reservedTokens();
            if (available >= need) {
                quotaRepository.addReserved(balance.id(), need);
                chosen = item;
                break;
            }
        }

        boolean overagePath = false;
        if (chosen == null) {
            if ("block".equals(route.exhaustAction())) {
                ledgerRepository.insertBlocked(requestId, month, userId, route.id(), model.id(), sessionId);
                throw new LlmException("LLM_QUOTA_EXHAUSTED",
                    "本月所有额度池额度均不足,请联系管理员调整额度", 409);
            }
            if (lastEnabledItem == null) {
                throw new LlmException("LLM_ROUTE_NOT_CONFIGURED",
                    "路由无可用顺位项,请联系管理员", 403);
            }
            // 软提醒:兜底到最后一个有效顺位,余额行 limit 按其当月 grant(无 grant 视为 0)
            chosen = lastEnabledItem;
            overagePath = true;
            long limit = quotaRepository.findEffectiveGrant(chosen.sourceType(), chosen.sourceId(),
                    model.id(), today)
                .map(QuotaGrantDto::monthlyLimitTokens)
                .orElse(0L);
            var balance = quotaRepository.lockOrCreateBalance(month, chosen.sourceType(),
                chosen.sourceId(), model.id(), limit);
            quotaRepository.addReserved(balance.id(), need);
        }

        UUID orgUnitId = "org_unit".equals(chosen.sourceType()) ? chosen.sourceId() : null;
        ledgerRepository.insertReserved(requestId, month, userId, route.id(), chosen.id(),
            chosen.priority(), orgUnitId, chosen.sourceType(), chosen.sourceId(),
            model.id(), sessionId, need);
        return new Reservation(requestId, month, model, chosen, need, overagePath);
    }

    // ---------- 转发与结算 ----------

    /**
     * 非流式调用:整体读取 New API 响应,透传给员工端并按 usage 结算。
     */
    public byte[] callAndSettle(Reservation reservation, Map<String, Object> requestBody,
                                int[] statusOut, Map<String, String> headersOut) {
        Map<String, Object> outgoing = prepareOutgoing(reservation, requestBody);
        try {
            HttpResponse<byte[]> response = httpClient.send(buildRequest(outgoing),
                HttpResponse.BodyHandlers.ofByteArray());
            statusOut[0] = response.statusCode();
            response.headers().firstValue("content-type")
                .ifPresent(ct -> headersOut.put("Content-Type", ct));
            if (response.statusCode() == 200) {
                JsonNode body = readTree(response.body());
                settleFromUsage(reservation, body.path("usage"),
                    body.path("id").asText(null));
            } else {
                release(reservation.requestId(), "failed", "LLM_GATEWAY_CALL_FAILED",
                    "New API HTTP " + response.statusCode());
            }
            return response.body();
        } catch (HttpTimeoutException e) {
            long seconds = newApiProperties.responseTimeout().toSeconds();
            release(reservation.requestId(), "failed", "LLM_UPSTREAM_TIMEOUT",
                "New API 在 " + seconds + "s 内未返回响应头");
            throw new LlmException("LLM_UPSTREAM_TIMEOUT",
                "上游服务在 " + seconds + "s 内未响应,请稍后重试", 504);
        } catch (IOException e) {
            release(reservation.requestId(), "failed", "LLM_GATEWAY_CALL_FAILED", e.getMessage());
            throw new LlmException("LLM_GATEWAY_CALL_FAILED", "New API 调用失败: " + e.getMessage(), 502);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            release(reservation.requestId(), "cancelled", "LLM_REQUEST_INTERRUPTED", e.getMessage());
            throw new LlmException("LLM_GATEWAY_CALL_FAILED", "调用被中断", 502);
        }
    }

    /**
     * 流式调用:逐行转发 SSE,同时从流中提取 usage 完成结算。
     * 算法:New API 在 stream_options.include_usage=true 时于末尾 chunk 返回 usage;
     * 流的最后一行处理完后即结算,客户端断连按 cancelled 释放预留。
     */
    public void streamAndSettle(Reservation reservation, Map<String, Object> requestBody,
                                OutputStream clientOut) {
        Map<String, Object> outgoing = prepareOutgoing(reservation, requestBody);
        outgoing.put("stream", true);
        Map<String, Object> streamOptions = new HashMap<>();
        Object existing = requestBody.get("stream_options");
        if (existing instanceof Map<?, ?> existingMap) {
            existingMap.forEach((k, v) -> streamOptions.put(String.valueOf(k), v));
        }
        streamOptions.put("include_usage", true);
        outgoing.put("stream_options", streamOptions);

        JsonNode usage = null;
        String gatewayRequestId = null;
        try {
            HttpResponse<InputStream> response = httpClient.send(buildRequest(outgoing),
                HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() != 200) {
                String errorBody = new String(response.body().readAllBytes(), StandardCharsets.UTF_8);
                release(reservation.requestId(), "failed", "LLM_GATEWAY_CALL_FAILED",
                    "New API HTTP " + response.statusCode() + ": " + abbreviate(errorBody));
                throw new LlmException("LLM_GATEWAY_CALL_FAILED",
                    "New API 调用失败(HTTP " + response.statusCode() + "): " + abbreviate(errorBody), 502);
            }
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    clientOut.write(line.getBytes(StandardCharsets.UTF_8));
                    clientOut.write('\n');
                    clientOut.flush();
                    if (line.startsWith("data:") && !"data: [DONE]".equals(line.trim())) {
                        JsonNode chunk = readTree(line.substring(5).trim().getBytes(StandardCharsets.UTF_8));
                        if (chunk != null) {
                            if (chunk.hasNonNull("usage")) {
                                usage = chunk.get("usage");
                            }
                            if (gatewayRequestId == null && chunk.hasNonNull("id")) {
                                gatewayRequestId = chunk.get("id").asText();
                            }
                        }
                    }
                }
            }
            clientOut.flush();
            settleFromUsage(reservation, usage, gatewayRequestId);
        } catch (HttpTimeoutException e) {
            long seconds = newApiProperties.responseTimeout().toSeconds();
            release(reservation.requestId(), "failed", "LLM_UPSTREAM_TIMEOUT",
                "New API 在 " + seconds + "s 内未返回响应头");
            throw new LlmException("LLM_UPSTREAM_TIMEOUT",
                "上游服务在 " + seconds + "s 内未响应,请稍后重试", 504);
        } catch (IOException e) {
            release(reservation.requestId(), "cancelled", "LLM_STREAM_INTERRUPTED", e.getMessage());
            throw new LlmException("LLM_GATEWAY_CALL_FAILED", "流式传输中断: " + e.getMessage(), 502);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            release(reservation.requestId(), "cancelled", "LLM_REQUEST_INTERRUPTED", e.getMessage());
            throw new LlmException("LLM_GATEWAY_CALL_FAILED", "调用被中断", 502);
        }
    }

    // ---------- 结算与释放 ----------

    /**
     * 按 usage 结算。
     * 算法:释放全部预留,实扣 actual;超出该池"当月 limit - 已消耗"的部分计入 overage_tokens。
     * usage 缺失时按 0 实扣并释放预留,避免预留泄漏。
     * 说明:经同类内部调用,@Transactional 不会走代理,统一用 TransactionTemplate 保证事务边界。
     */
    public void settleFromUsage(Reservation reservation, JsonNode usage, String gatewayRequestId) {
        long prompt = usage != null ? usage.path("prompt_tokens").asLong(0) : 0;
        long completion = usage != null ? usage.path("completion_tokens").asLong(0) : 0;
        long finalPrompt = prompt;
        long finalCompletion = completion;
        transactionTemplate.executeWithoutResult(status ->
            settle(reservation, finalPrompt, finalCompletion, gatewayRequestId));
    }

    private void settle(Reservation reservation, long promptTokens, long completionTokens,
                        String gatewayRequestId) {
        var locked = ledgerRepository.findByRequestIdForUpdate(reservation.requestId());
        if (locked.isEmpty() || !"reserved".equals(locked.get().status())) {
            return;
        }
        long total = promptTokens + completionTokens;
        var balance = quotaRepository.lockOrCreateBalance(reservation.usageMonth(),
            reservation.chosenItem().sourceType(), reservation.chosenItem().sourceId(),
            reservation.model().id(), 0);
        long availableBefore = Math.max(0, balance.limitTokens() - balance.consumedTokens());
        long overage = Math.max(0, total - availableBefore);
        quotaRepository.settle(balance.id(), reservation.reservedTokens(), total, overage);
        ledgerRepository.complete(reservation.requestId(), promptTokens, completionTokens,
            overage, estimateCost(reservation.model(), promptTokens, completionTokens),
            gatewayRequestId);
    }

    /** 失败/取消释放预留;幂等。 */
    public void release(String requestId, String status, String errorCode, String errorMessage) {
        transactionTemplate.executeWithoutResult(txStatus -> {
            var locked = ledgerRepository.findByRequestIdForUpdate(requestId);
            if (locked.isEmpty() || !"reserved".equals(locked.get().status())) {
                return;
            }
            var row = locked.get();
            var balance = quotaRepository.lockOrCreateBalance(row.usageMonth(), row.sourceType(),
                row.sourceId(), row.modelId(), 0);
            quotaRepository.releaseReserved(balance.id(), row.reservedTokens());
            ledgerRepository.fail(requestId, status, errorCode, errorMessage);
        });
    }

    // ---------- 内部 ----------

    private Map<String, Object> prepareOutgoing(Reservation reservation, Map<String, Object> requestBody) {
        Map<String, Object> outgoing = new HashMap<>(requestBody);
        // 逻辑模型名由 New API 渠道 model_mapping 重定向到上游真实模型名
        outgoing.put("model", reservation.model().gatewayModelName());
        return outgoing;
    }

    private HttpRequest buildRequest(Map<String, Object> outgoing) {
        try {
            // timeout:等待响应头的上限(TTFB);上游挂起不吐头时抛 HttpTimeoutException 快速失败,
            // 而不是挂到 spring.mvc.async.request-timeout 才被异步超时掐断
            return HttpRequest.newBuilder()
                .uri(URI.create(newApiProperties.baseUrl() + "/v1/chat/completions"))
                .header("Authorization", "Bearer " + newApiProperties.serviceToken())
                .header("Content-Type", "application/json")
                .timeout(newApiProperties.responseTimeout())
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(outgoing)))
                .build();
        } catch (Exception e) {
            throw new IllegalArgumentException("请求体序列化失败: " + e.getMessage());
        }
    }

    /**
     * 成本估算。
     * 算法:model_params_json 可配 inputPricePer1M / outputPricePer1M(USD);未配置时为 0。
     */
    private BigDecimal estimateCost(EnterpriseModelDto model, long promptTokens, long completionTokens) {
        Map<String, Object> params = model.modelParams();
        double inputPrice = params.get("inputPricePer1M") instanceof Number n ? n.doubleValue() : 0;
        double outputPrice = params.get("outputPricePer1M") instanceof Number n ? n.doubleValue() : 0;
        double cost = promptTokens * inputPrice / 1_000_000d
            + completionTokens * outputPrice / 1_000_000d;
        return BigDecimal.valueOf(cost).setScale(6, RoundingMode.HALF_UP);
    }

    private JsonNode readTree(byte[] body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            return null;
        }
    }

    private String abbreviate(String text) {
        if (text == null) {
            return null;
        }
        return text.length() <= 500 ? text : text.substring(0, 500);
    }
}
