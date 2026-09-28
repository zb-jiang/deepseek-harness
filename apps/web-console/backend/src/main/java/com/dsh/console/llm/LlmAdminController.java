package com.dsh.console.llm;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.llm.dto.EnterpriseModelDto;
import com.dsh.console.llm.dto.QuotaGrantDto;
import com.dsh.console.llm.dto.UserModelRouteDto;
import com.dsh.console.security.AuthContext;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * LLM 治理管理端 API。
 * 业务含义:web-console 后台"LLM 管理"三个页签(模型接入/额度配置/用量分析)的配置面接口;
 * 全部限 system_admin。
 */
@RestController
@RequestMapping("/api/admin/llm")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class LlmAdminController {

    /** 创建企业模型请求。 */
    public record CreateModelRequest(String displayName,
                                     String gatewayModelName,
                                     Map<String, Object> modelParams, Integer reservationTokens) {}

    /** 更新企业模型请求。 */
    public record UpdateModelRequest(String displayName, String gatewayModelName,
                                     Map<String, Object> modelParams, Integer reservationTokens) {}

    /** 创建额度授权请求。 */
    public record CreateGrantRequest(String subjectType, UUID subjectId, UUID modelId,
                                     Long monthlyLimitTokens, LocalDate effectiveFrom,
                                     LocalDate effectiveTo) {}

    /** 更新额度授权请求。 */
    public record UpdateGrantRequest(Long monthlyLimitTokens, LocalDate effectiveFrom,
                                     LocalDate effectiveTo) {}

    /** 路由顺位项参数。 */
    public record RouteItemParam(Integer priority, String sourceType, UUID sourceId) {}

    /** 创建路由请求。 */
    public record CreateRouteRequest(UUID userId, UUID modelId, String exhaustAction,
                                     List<RouteItemParam> items) {}

    /** 更新路由请求。items 为空表示不动顺位项。 */
    public record UpdateRouteRequest(String exhaustAction, Boolean enabled, List<RouteItemParam> items) {}

    private final LlmModelService modelService;
    private final LlmQuotaService quotaService;

    public LlmAdminController(LlmModelService modelService, LlmQuotaService quotaService) {
        this.modelService = modelService;
        this.quotaService = quotaService;
    }

    // ---------- 企业模型 ----------

    @GetMapping("/models")
    public ApiResponse<List<EnterpriseModelDto>> listModels() {
        return ApiResponse.ok(modelService.listModels());
    }

    @PostMapping("/models")
    public ApiResponse<EnterpriseModelDto> createModel(@RequestBody CreateModelRequest req,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(modelService.createModel(req.displayName(),
            req.gatewayModelName(),
            req.modelParams(), req.reservationTokens() == null ? 0 : req.reservationTokens(),
            auth.platformUserId()));
    }

    @PutMapping("/models/{id}")
    public ApiResponse<EnterpriseModelDto> updateModel(@PathVariable UUID id,
                                                       @RequestBody UpdateModelRequest req,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(modelService.updateModel(id, req.displayName(), req.gatewayModelName(),
            req.modelParams(),
            req.reservationTokens() == null ? 0 : req.reservationTokens(), auth.platformUserId()));
    }

    @PostMapping("/models/{id}/enable")
    public ApiResponse<EnterpriseModelDto> enableModel(@PathVariable UUID id,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(modelService.setModelEnabled(id, true, auth.platformUserId()));
    }

    @PostMapping("/models/{id}/disable")
    public ApiResponse<EnterpriseModelDto> disableModel(@PathVariable UUID id,
                                                        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(modelService.setModelEnabled(id, false, auth.platformUserId()));
    }

    @DeleteMapping("/models/{id}")
    public ApiResponse<Void> deleteModel(@PathVariable UUID id,
                                         @AuthenticationPrincipal AuthContext auth) {
        modelService.deleteModel(id, auth.platformUserId());
        return ApiResponse.ok();
    }

    // New API 模型清单,网关模型名的合法取值源
    @GetMapping("/newapi/models")
    public ApiResponse<List<String>> listNewapiModels() {
        return ApiResponse.ok(modelService.listNewapiModelNames());
    }

    // ---------- 额度授权 ----------

    @GetMapping("/quota-grants")
    public ApiResponse<List<QuotaGrantDto>> listGrants(@RequestParam(required = false) UUID modelId) {
        return ApiResponse.ok(quotaService.listGrants(modelId));
    }

    @PostMapping("/quota-grants")
    public ApiResponse<QuotaGrantDto> createGrant(@RequestBody CreateGrantRequest req,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(quotaService.createGrant(req.subjectType(), req.subjectId(), req.modelId(),
            req.monthlyLimitTokens() == null ? -1 : req.monthlyLimitTokens(),
            req.effectiveFrom(), req.effectiveTo(), auth.platformUserId()));
    }

    @PutMapping("/quota-grants/{id}")
    public ApiResponse<QuotaGrantDto> updateGrant(@PathVariable UUID id,
                                                  @RequestBody UpdateGrantRequest req,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(quotaService.updateGrant(id,
            req.monthlyLimitTokens() == null ? -1 : req.monthlyLimitTokens(),
            req.effectiveFrom(), req.effectiveTo(), auth.platformUserId()));
    }

    @PostMapping("/quota-grants/{id}/enable")
    public ApiResponse<QuotaGrantDto> enableGrant(@PathVariable UUID id,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(quotaService.setGrantEnabled(id, true, auth.platformUserId()));
    }

    @PostMapping("/quota-grants/{id}/disable")
    public ApiResponse<QuotaGrantDto> disableGrant(@PathVariable UUID id,
                                                   @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(quotaService.setGrantEnabled(id, false, auth.platformUserId()));
    }

    // ---------- 用户模型路由 ----------

    @GetMapping("/routes")
    public ApiResponse<List<UserModelRouteDto>> listRoutes(@RequestParam(required = false) UUID userId) {
        return ApiResponse.ok(quotaService.listRoutes(userId));
    }

    @PostMapping("/routes")
    public ApiResponse<UserModelRouteDto> createRoute(@RequestBody CreateRouteRequest req,
                                                      @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(quotaService.upsertRoute(req.userId(), req.modelId(), req.exhaustAction(),
            toInputs(req.items()), auth.platformUserId()));
    }

    @PutMapping("/routes/{id}")
    public ApiResponse<UserModelRouteDto> updateRoute(@PathVariable UUID id,
                                                      @RequestBody UpdateRouteRequest req,
                                                      @AuthenticationPrincipal AuthContext auth) {
        UserModelRouteDto existing = quotaService.getRoute(id);
        return ApiResponse.ok(quotaService.updateRoute(id,
            req.exhaustAction() != null ? req.exhaustAction() : existing.exhaustAction(),
            req.enabled() != null ? req.enabled() : existing.enabled(),
            req.items() != null ? toInputs(req.items()) : null,
            auth.platformUserId()));
    }

    private List<LlmQuotaJdbcRepository.RouteItemInput> toInputs(List<RouteItemParam> items) {
        if (items == null) {
            return List.of();
        }
        return items.stream()
            .map(i -> new LlmQuotaJdbcRepository.RouteItemInput(i.priority(), i.sourceType(), i.sourceId()))
            .toList();
    }
}
