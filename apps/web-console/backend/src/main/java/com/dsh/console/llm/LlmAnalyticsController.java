package com.dsh.console.llm;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.llm.dto.UsageLedgerEntry;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 用量分析 API。
 * 业务含义:web-console 后台"用量分析"页签;提供维度汇总、每日热力图与账本明细三类查询。
 */
@RestController
@RequestMapping("/api/admin/llm/usage")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class LlmAnalyticsController {

    private final LlmAnalyticsService analyticsService;

    public LlmAnalyticsController(LlmAnalyticsService analyticsService) {
        this.analyticsService = analyticsService;
    }

    /**
     * 维度汇总。
     * dimension: user(按发起人) / org_unit(按实际扣费部门池) / model(按模型);month 格式 YYYY-MM。
     */
    @GetMapping("/summary")
    public ApiResponse<List<LlmLedgerJdbcRepository.SummaryRow>> summary(@RequestParam String dimension,
                                                                         @RequestParam String month) {
        return ApiResponse.ok(analyticsService.summary(dimension, month));
    }

    /** 近一年每日消耗热力图,全对象按天聚合(与维度筛选无关)。 */
    @GetMapping("/heatmap/year")
    public ApiResponse<List<LlmLedgerJdbcRepository.DailyTotal>> heatmapYear() {
        return ApiResponse.ok(analyticsService.heatmapYear());
    }

    /** 账本明细分页。 */
    @GetMapping("/ledger")
    public ApiResponse<Map<String, Object>> ledger(@RequestParam(required = false) String month,
                                                   @RequestParam(required = false) UUID userId,
                                                   @RequestParam(required = false) UUID modelId,
                                                   @RequestParam(required = false) String status,
                                                   @RequestParam(defaultValue = "1") int page,
                                                   @RequestParam(defaultValue = "20") int pageSize) {
        int safePage = Math.max(1, page);
        int safeSize = Math.min(100, Math.max(1, pageSize));
        List<UsageLedgerEntry> items = analyticsService.listLedger(month, userId, modelId, status,
            safeSize, (safePage - 1) * safeSize);
        long total = analyticsService.countLedger(month, userId, modelId, status);
        return ApiResponse.ok(Map.of("items", items, "total", total,
            "page", safePage, "pageSize", safeSize));
    }
}
