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
import java.util.Map;
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
                    model.gatewayModelName(), model.displayName(),
                    positiveIntParam(model.modelParams(), "contextWindow"),
                    positiveIntParam(model.modelParams(), "maxTokens"),
                    reasoningParam(model.modelParams()),
                    route.exhaustAction(), pools));
            });
        }
        return result;
    }

    /**
     * 读 model_params_json 约定键的正整数参数。
     * 业务含义:contextWindow/maxTokens 供员工端 DSH(llm-access 插件)注册 LLM 路由;
     * 缺省或非正数返回 null,由员工端按其配置兜底。
     */
    private static Integer positiveIntParam(Map<String, Object> modelParams, String key) {
        Object value = modelParams == null ? null : modelParams.get(key);
        if (value instanceof Number number) {
            int i = number.intValue();
            return i > 0 ? i : null;
        }
        return null;
    }

    /**
     * 读 model_params_json 约定键 reasoning(布尔)。
     * 业务含义:声明模型支持推理档位,员工端 DSH 据此在选择器中显示"推理等级"选项;
     * 缺省视为不支持(null 与 false 同效,员工端仅对 true 声明档位)。
     */
    private static Boolean reasoningParam(Map<String, Object> modelParams) {
        Object value = modelParams == null ? null : modelParams.get("reasoning");
        return Boolean.TRUE.equals(value) ? Boolean.TRUE : null;
    }

    private EmployeeModelDto.PoolSummary buildPool(UserModelRouteDto.RouteItemDto item,
                                                   EnterpriseModelDto model,
                                                   QuotaGrantDto grant, String month) {
        var balance = quotaRepository.findBalance(month, item.sourceType(), item.sourceId(), model.id());
        long consumed = balance.map(LlmQuotaJdbcRepository.BalanceRow::consumedTokens).orElse(0L);
        long reserved = balance.map(LlmQuotaJdbcRepository.BalanceRow::reservedTokens).orElse(0L);
        long limit = grant.monthlyLimitTokens();
        return new EmployeeModelDto.PoolSummary(
            item.priority(),
            item.sourceType(),
            item.sourceId(),
            item.sourceName(),
            limit,
            consumed,
            reserved,
            // -1 表示不限量,剩余原样传 -1 由员工端展示"不限量"。
            limit < 0 ? -1 : limit - consumed - reserved
        );
    }
}
