package com.dsh.console.llm;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.llm.dto.UsageLedgerEntry;
import com.dsh.console.security.AuthContext;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 用量分析 API。
 * 业务含义:web-console 后台"用量分析"页签;提供维度汇总、每日热力图与账本明细三类查询。
 * 角色模型:维度汇总仅系统管理员(全貌);热力图与明细全员可用,但非系统管理员被服务端
 * 强制收敛到本人数据——前端传入的 userId 过滤参数对非管理员一律忽略,不泄露他人记录。
 */
@RestController
@RequestMapping("/api/admin/llm/usage")
public class LlmAnalyticsController {

    private final LlmAnalyticsService analyticsService;

    public LlmAnalyticsController(LlmAnalyticsService analyticsService) {
        this.analyticsService = analyticsService;
    }

    /**
     * 维度汇总(仅系统管理员)。
     * dimension: user(按发起人) / org_unit(按实际扣费部门池) / model(按模型);month 格式 YYYY-MM。
     */
    @GetMapping("/summary")
    @PreAuthorize("hasRole('SYSTEM_ADMIN')")
    public ApiResponse<List<LlmLedgerJdbcRepository.SummaryRow>> summary(@RequestParam String dimension,
                                                                         @RequestParam String month) {
        return ApiResponse.ok(analyticsService.summary(dimension, month));
    }

    /** 近一年每日消耗热力图,系统管理员看全对象合计,其余用户仅本人(与维度筛选无关)。 */
    @GetMapping("/heatmap/year")
    public ApiResponse<List<LlmLedgerJdbcRepository.DailyTotal>> heatmapYear(
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(analyticsService.heatmapYear(
            auth.isSystemAdmin() ? null : auth.platformUserId()));
    }

    /**
     * 账本明细分页;非系统管理员强制按本人过滤,userId 参数忽略。
     * from/to 作用于 created_at,ISO-8601 含时区,to 为排他上界;sourceType/sourceId 必须成对传。
     */
    @GetMapping("/ledger")
    public ApiResponse<Map<String, Object>> ledger(@AuthenticationPrincipal AuthContext auth,
                                                   @RequestParam(required = false) OffsetDateTime from,
                                                   @RequestParam(required = false) OffsetDateTime to,
                                                   @RequestParam(required = false) UUID userId,
                                                   @RequestParam(required = false) UUID modelId,
                                                   @RequestParam(required = false) String sourceType,
                                                   @RequestParam(required = false) UUID sourceId,
                                                   @RequestParam(required = false) String status,
                                                   @RequestParam(defaultValue = "1") int page,
                                                   @RequestParam(defaultValue = "20") int pageSize) {
        if (from != null && to != null && from.isAfter(to)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "时间区间起点晚于终点");
        }
        if (sourceType != null && sourceId == null || sourceType == null && sourceId != null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "sourceType 与 sourceId 必须成对传入");
        }
        UUID userScope = auth.isSystemAdmin() ? userId : auth.platformUserId();
        int safePage = Math.max(1, page);
        int safeSize = Math.min(100, Math.max(1, pageSize));
        List<UsageLedgerEntry> items = analyticsService.listLedger(from, to, userScope, modelId,
            sourceType, sourceId, status, safeSize, (safePage - 1) * safeSize);
        long total = analyticsService.countLedger(from, to, userScope, modelId, sourceType,
            sourceId, status);
        return ApiResponse.ok(Map.of("items", items, "total", total,
            "page", safePage, "pageSize", safeSize));
    }

    /**
     * 账本筛选下拉选项(用户/模型/扣费来源)。
     * 业务含义:选项从账本 DISTINCT 而非配置表,已删除实体仍可按历史名筛选;
     * 非系统管理员只看到自己账本中出现过的基础数据。
     */
    @GetMapping("/ledger/filters")
    public ApiResponse<LlmLedgerJdbcRepository.LedgerFilterOptions> ledgerFilters(
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(analyticsService.ledgerFilterOptions(
            auth.isSystemAdmin() ? null : auth.platformUserId()));
    }
}
