package com.dsh.console.llm;

import com.dsh.console.audit.AuditService;
import com.dsh.console.llm.dto.EnterpriseModelDto;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 企业模型管理。
 * 业务含义:管理本地模型目录;网关模型名的唯一合法取值源是 New API 模型清单
 * (/v1/models,即转发令牌可路由集合)——创建时校验、创建后锁定,
 * 避免产生转发必然失败的空壳引用;New API 渠道本身由管理员在 New API 控制台手工创建维护。
 */
@Service
public class LlmModelService {

    private final LlmCatalogJdbcRepository catalogRepository;
    private final NewApiClient newApiClient;
    private final LlmQuotaJdbcRepository quotaRepository;
    private final LlmLedgerJdbcRepository ledgerRepository;
    private final AuditService auditService;
    private final TransactionTemplate transactionTemplate;

    public LlmModelService(LlmCatalogJdbcRepository catalogRepository,
                           NewApiClient newApiClient,
                           LlmQuotaJdbcRepository quotaRepository,
                           LlmLedgerJdbcRepository ledgerRepository,
                           AuditService auditService,
                           TransactionTemplate transactionTemplate) {
        this.catalogRepository = catalogRepository;
        this.newApiClient = newApiClient;
        this.quotaRepository = quotaRepository;
        this.ledgerRepository = ledgerRepository;
        this.auditService = auditService;
        this.transactionTemplate = transactionTemplate;
    }

    // ---------- 企业模型 ----------

    public List<EnterpriseModelDto> listModels() {
        return catalogRepository.listModels();
    }

    /**
     * 创建企业模型。
     * 算法:先调 New API 校验网关模型名在模型清单中存在(不可达时保存失败),再在本地事务内落库。
     */
    public EnterpriseModelDto createModel(String displayName, String gatewayModelName,
                                          Map<String, Object> modelParams, int reservationTokens,
                                          UUID operatorId) {
        validateModelInput(displayName, gatewayModelName, reservationTokens);
        requireGatewayModelInNewApi(gatewayModelName);
        UUID id;
        try {
            id = transactionTemplate.execute(status -> {
                UUID newId = catalogRepository.insertModel(displayName,
                    gatewayModelName, modelParams, reservationTokens);
                auditService.record("LLM_MODEL_CREATE", "llm_enterprise_model", newId, operatorId,
                    Map.of("gatewayModelName", gatewayModelName));
                return newId;
            });
        } catch (DuplicateKeyException e) {
            throw new LlmException("LLM_GATEWAY_MODEL_EXISTS", "网关模型名已存在: " + gatewayModelName, 409);
        }
        return catalogRepository.findModelById(id).orElseThrow();
    }

    /**
     * 更新企业模型。
     * 网关模型名创建后锁定:额度判定与用量账本都按它归属,改名会使历史数据断裂。
     * 传入为空表示未提供(保持原值),与原值不同则拒绝。
     */
    public EnterpriseModelDto updateModel(UUID id, String displayName, String gatewayModelName,
                                          Map<String, Object> modelParams,
                                          int reservationTokens, UUID operatorId) {
        EnterpriseModelDto existing = catalogRepository.findModelById(id)
            .orElseThrow(() -> new LlmException("LLM_MODEL_NOT_FOUND", "模型不存在", 404));
        String effectiveGatewayModelName = existing.gatewayModelName();
        if (gatewayModelName != null && !gatewayModelName.isBlank()
            && !gatewayModelName.equals(existing.gatewayModelName())) {
            throw new LlmException("LLM_GATEWAY_MODEL_LOCKED",
                "网关模型名创建后不可修改: " + existing.gatewayModelName(), 400);
        }
        transactionTemplate.executeWithoutResult(status -> {
            catalogRepository.updateModel(id, displayName, effectiveGatewayModelName,
                modelParams, reservationTokens);
            auditService.record("LLM_MODEL_UPDATE", "llm_enterprise_model", id, operatorId, null);
        });
        return catalogRepository.findModelById(id).orElseThrow();
    }

    @Transactional
    public EnterpriseModelDto setModelEnabled(UUID id, boolean enabled, UUID operatorId) {
        catalogRepository.findModelById(id)
            .orElseThrow(() -> new LlmException("LLM_MODEL_NOT_FOUND", "模型不存在", 404));
        catalogRepository.setModelEnabled(id, enabled);
        auditService.record(enabled ? "LLM_MODEL_ENABLE" : "LLM_MODEL_DISABLE",
            "llm_enterprise_model", id, operatorId, null);
        return catalogRepository.findModelById(id).orElseThrow();
    }

    /**
     * 拉取 New API 模型名清单,供管理端模型接入页下拉选择网关模型名。
     */
    public List<String> listNewapiModelNames() {
        return newApiClient.listModelNames();
    }

    /**
     * 删除企业模型。
     * 已有任何用量账本记录的模型拒绝物理删除(账本 append-only 且统计内 JOIN 模型表),提示改用停用;
     * 仅被授权/路由/余额等配置面引用时,事务内级联清理后删除。
     */
    public void deleteModel(UUID id, UUID operatorId) {
        EnterpriseModelDto existing = catalogRepository.findModelById(id)
            .orElseThrow(() -> new LlmException("LLM_MODEL_NOT_FOUND", "模型不存在", 404));
        if (ledgerRepository.existsByModelId(id)) {
            throw new LlmException("LLM_MODEL_IN_USE",
                "模型「" + existing.displayName() + "」已有用量记录,为保证账本与统计完整性不可删除,请改用停用", 409);
        }
        transactionTemplate.executeWithoutResult(status -> {
            quotaRepository.deleteModelReferences(id);
            catalogRepository.deleteModel(id);
            auditService.record("LLM_MODEL_DELETE", "llm_enterprise_model", id, operatorId,
                Map.of("gatewayModelName", existing.gatewayModelName()));
        });
    }

    // ---------- 内部 ----------

    private void validateModelInput(String displayName, String gatewayModelName, int reservationTokens) {
        if (displayName == null || displayName.isBlank()) {
            throw new IllegalArgumentException("displayName 不能为空");
        }
        if (gatewayModelName == null || gatewayModelName.isBlank()) {
            throw new IllegalArgumentException("gatewayModelName 不能为空");
        }
        if (reservationTokens <= 0) {
            throw new IllegalArgumentException("reservationTokens 必须大于 0");
        }
    }

    /**
     * 网关模型名存在性校验:必须出现在 New API 模型清单中。
     * New API 不可达时报错阻塞保存,不静默放行,避免产生转发必然失败的空壳引用。
     */
    private void requireGatewayModelInNewApi(String gatewayModelName) {
        List<String> names = newApiClient.listModelNames();
        if (!names.contains(gatewayModelName)) {
            throw new LlmException("LLM_GATEWAY_MODEL_NOT_IN_NEWAPI",
                "网关模型名在 New API 模型清单中不存在: " + gatewayModelName
                    + ",请先在 New API 渠道中配置该模型名", 400);
        }
    }
}
