package com.dsh.console.llm;

import java.time.OffsetDateTime;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 孤儿预留定时清扫。
 * 业务含义:正常请求的预留会在结算/释放中流转为终态;进程崩溃或代理端点异常会让部分
 * 预留永远停留在 reserved,持续占用额度池 reserved_tokens。本作业周期性地把超过阈值
 * (默认 60 分钟)仍是 reserved 的账本行按失败释放,复用 {@link LlmProxyService#release}
 * 的幂等释放路径——与迟到的结算互斥(行锁 + 仅 reserved 可迁移),先到先得。
 */
@Component
public class LlmReservationSweeper {

    private static final Logger log = LoggerFactory.getLogger(LlmReservationSweeper.class);

    private final LlmLedgerJdbcRepository ledgerRepository;
    private final LlmProxyService proxyService;
    /** 预留被视为孤儿的最小年龄(分钟);须大于正常调用的最长耗时。 */
    private final long staleMinutes;
    /** 单轮清扫最大行数,防止极端积压拖长单轮耗时;余量留给下一轮。 */
    private final int batchSize;

    public LlmReservationSweeper(LlmLedgerJdbcRepository ledgerRepository,
                                 LlmProxyService proxyService,
                                 @Value("${dsh.llm.reservation-stale-minutes:60}") long staleMinutes,
                                 @Value("${dsh.llm.reservation-sweep-batch-size:500}") int batchSize) {
        this.ledgerRepository = ledgerRepository;
        this.proxyService = proxyService;
        this.staleMinutes = staleMinutes;
        this.batchSize = batchSize;
    }

    /** 周期清扫(默认 10 分钟,{@code dsh.llm.reservation-sweep-interval-ms} 可调)。 */
    @Scheduled(fixedDelayString = "${dsh.llm.reservation-sweep-interval-ms:600000}")
    public void sweep() {
        List<String> staleIds = ledgerRepository.findStaleReservedRequestIds(
            OffsetDateTime.now().minusMinutes(staleMinutes), batchSize);
        for (String requestId : staleIds) {
            proxyService.release(requestId, "failed", "LLM_RESERVATION_STALE",
                "预留超时未结算,已由定时清扫释放");
        }
        if (!staleIds.isEmpty()) {
            log.info("孤儿预留清扫: 释放 {} 笔(超龄阈值 {} 分钟)", staleIds.size(), staleMinutes);
        }
    }
}
