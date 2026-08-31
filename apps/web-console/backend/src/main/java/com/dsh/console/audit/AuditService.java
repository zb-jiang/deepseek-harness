package com.dsh.console.audit;

import com.dsh.console.audit.dto.AuditEventDto;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * 审计事件写入与查询业务编排。
 *
 * <p>写操作由各 Service 在业务事务内调用 {@link #record};Spring 事务管理器保证
 * 审计与业务数据同事务一致(spec §13.2 + §12.6 不变量)。
 *
 * <p>读操作由 {@link AuditController} 调用,查审计页。
 */
@Service
public class AuditService {

    private final AuditJdbcRepository auditRepository;

    public AuditService(AuditJdbcRepository auditRepository) {
        this.auditRepository = auditRepository;
    }

    /**
     * 写审计事件(同步、业务事务内)。
     *
     * @param eventType    事件类型(USER_APPROVE / APP_CREATE / WORKFLOW_PUBLISH 等)
     * @param targetType   目标类型(platform_user / application / app_role / app_membership / workflow_definition)
     @param targetUserId  目标用户 ID(可空;目标非 user 时存到 details.targetId/targetType)
     * @param operatorId   操作人 ID(platform_users.id,可空,trigger 自动操作时为 null)
     * @param details      详情(可空)
     */
    public void record(String eventType, String targetType, UUID targetUserId,
                       UUID operatorId, Map<String, Object> details) {
        // details 兼容目标非 user 的场景:把 targetType/targetId 写入 details
        Map<String, Object> enriched = details == null ? new java.util.HashMap<>() : new java.util.HashMap<>(details);
        if (targetType != null) {
            enriched.putIfAbsent("targetType", targetType);
        }
        if (targetUserId != null && !"platform_user".equals(targetType)) {
            enriched.putIfAbsent("targetId", targetUserId);
        }
        auditRepository.insert(eventType, targetUserId, operatorId, enriched);
    }

    /**
     * 列审计事件(可按 event_type 与 operator_id 过滤)。
     */
    public List<AuditEventDto> list(String eventTypeFilter, UUID operatorIdFilter, int offset, int limit) {
        return auditRepository.list(eventTypeFilter, operatorIdFilter, offset, limit);
    }

    /**
     * 按目标用户查(用户治理页右侧"该用户的历史动作")。
     */
    public List<AuditEventDto> listByTargetUser(UUID targetUserId, int offset, int limit) {
        return auditRepository.listByTargetUser(targetUserId, offset, limit);
    }
}
