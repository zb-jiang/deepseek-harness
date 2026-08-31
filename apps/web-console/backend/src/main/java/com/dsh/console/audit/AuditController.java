package com.dsh.console.audit;

import com.dsh.console.audit.dto.AuditEventDto;
import com.dsh.console.common.ApiResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 审计日志查询端点。
 *
 * <p>V1 仅 {@code system_admin} 可访问;按 event_type / operator_id 过滤,分页查询。
 */
@RestController
@RequestMapping("/api/audit")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class AuditController {

    private final AuditService auditService;

    public AuditController(AuditService auditService) {
        this.auditService = auditService;
    }

    /**
     * 列审计事件。
     */
    @GetMapping
    public ApiResponse<List<AuditEventDto>> list(
        @RequestParam(required = false) String eventType,
        @RequestParam(required = false) UUID operatorId,
        @RequestParam(defaultValue = "0") int offset,
        @RequestParam(defaultValue = "50") int limit) {
        return ApiResponse.ok(auditService.list(eventType, operatorId, offset, limit));
    }

    /**
     * 按目标用户查(用户治理页"该用户的历史动作")。
     */
    @GetMapping("/by-user/{userId}")
    public ApiResponse<List<AuditEventDto>> listByUser(@PathVariable UUID userId,
                                                        @RequestParam(defaultValue = "0") int offset,
                                                        @RequestParam(defaultValue = "50") int limit) {
        return ApiResponse.ok(auditService.listByTargetUser(userId, offset, limit));
    }
}
