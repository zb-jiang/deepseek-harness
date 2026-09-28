package com.dsh.console.llm;

import com.dsh.console.llm.dto.EmployeeModelDto;
import com.dsh.console.llm.dto.EnterpriseModelDto;
import com.dsh.console.llm.dto.QuotaGrantDto;
import com.dsh.console.llm.dto.UserModelRouteDto;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 员工端模型目录。
 * 业务含义:员工只能看到"自己配了路由且模型已启用"的模型;
 * pools 按路由优先级给出每个额度池的当月概况,员工端选择器据此展示剩余额度。
 */
@Service
public class LlmEmployeeService {

    private static final DateTimeFormatter MONTH_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM");

    private final LlmQuotaJdbcRepository quotaRepository;
    private final LlmCatalogJdbcRepository catalogRepository;

    public LlmEmployeeService(LlmQuotaJdbcRepository quotaRepository,
                              LlmCatalogJdbcRepository catalogRepository) {
        this.quotaRepository = quotaRepository;
        this.catalogRepository = catalogRepository;
    }

    /**
     * 列出当前员工可用的企业模型。
     * 算法:路由(user+model, enabled) × 模型(enabled);每个顺位池查当月 grant 与余额快照。
     */
    public List<EmployeeModelDto> listModelsForUser(UUID userId) {
        String month = YearMonth.now().format(MONTH_FORMAT);
        LocalDate today = LocalDate.now();
        List<EmployeeModelDto> result = new ArrayList<>();
        for (UserModelRouteDto route : quotaRepository.listRoutes(userId)) {
            catalogRepository.findModelById(route.modelId()).ifPresent(model -> {
                if (!model.enabled()) {
                    return;
                }
                List<EmployeeModelDto.PoolSummary> pools = new ArrayList<>();
                for (UserModelRouteDto.RouteItemDto item : route.items()) {
                    if (!item.enabled()) {
                        continue;
                    }
                    quotaRepository.findEffectiveGrant(item.sourceType(), item.sourceId(),
                        model.id(), today).ifPresent(grant -> pools.add(
                        buildPool(item, model, grant, month)));
                }
                result.add(new EmployeeModelDto(model.id(),
                    model.gatewayModelName(), model.displayName(), route.exhaustAction(), pools));
            });
        }
        return result;
    }

    private EmployeeModelDto.PoolSummary buildPool(UserModelRouteDto.RouteItemDto item,
                                                   EnterpriseModelDto model,
                                                   QuotaGrantDto grant, String month) {
        var balance = quotaRepository.findBalance(month, item.sourceType(), item.sourceId(), model.id());
        long consumed = balance.map(LlmQuotaJdbcRepository.BalanceRow::consumedTokens).orElse(0L);
        long reserved = balance.map(LlmQuotaJdbcRepository.BalanceRow::reservedTokens).orElse(0L);
        return new EmployeeModelDto.PoolSummary(
            item.priority(),
            item.sourceType(),
            item.sourceId(),
            item.sourceName(),
            grant.monthlyLimitTokens(),
            consumed,
            reserved,
            grant.monthlyLimitTokens() - consumed - reserved
        );
    }
}
