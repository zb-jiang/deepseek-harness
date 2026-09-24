package com.expense.sor.web;

import com.expense.sor.exception.ForbiddenException;
import com.expense.sor.service.AttachmentService;
import com.expense.sor.service.ExpenseService;
import com.expense.sor.service.Validators;
import com.expense.sor.web.dto.CreateExpenseRequest;
import com.expense.sor.web.dto.ExpenseDetailDto;
import com.expense.sor.web.dto.ExpenseSummaryDto;
import com.expense.sor.web.dto.PaymentDto;
import com.expense.sor.web.dto.PaymentRequest;
import com.expense.sor.web.dto.ApprovalRecordRequest;
import com.expense.sor.web.dto.ProcessInstanceRequest;
import com.expense.sor.web.dto.StatusUpdateRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/**
 * 报销单 REST API(设计文档 §7,Base URL /api)。
 * 建单/附件/撤回/列表仅 JWT;读单/显式迁移/回写流程实例/审批记录/打款接受 JWT 或 X-Service-Key(§4)。
 */
@RestController
@RequestMapping("/api/expenses")
public class ExpenseController {

    private final ExpenseService service;
    private final AttachmentService attachmentService;

    public ExpenseController(ExpenseService service, AttachmentService attachmentService) {
        this.service = service;
        this.attachmentService = attachmentService;
    }

    /** 7.1 创建报销单(仅 JWT,创建即 opened) */
    @PostMapping
    public ExpenseDetailDto create(@RequestBody CreateExpenseRequest request) {
        return service.create(request, requireUserId());
    }

    /** 7.3 查询报销单(JWT 或 X-Service-Key),含明细/附件/审批记录/打款记录 */
    @GetMapping("/{id}")
    public ExpenseDetailDto get(@PathVariable String id) {
        return service.getDetail(Validators.requireUuid(id, "id"));
    }

    /** 7.3 附件下载(二进制流,不包裹信封) */
    @GetMapping("/{id}/attachments/{attachmentId}")
    @RawResponse
    public ResponseEntity<Resource> download(@PathVariable String id, @PathVariable String attachmentId) {
        var file = attachmentService.loadForDownload(
                Validators.requireUuid(id, "id"), Validators.requireUuid(attachmentId, "attachmentId"));
        String encodedName = URLEncoder.encode(file.row().fileName(), StandardCharsets.UTF_8)
                .replace("+", "%20");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename*=UTF-8''" + encodedName)
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(new FileSystemResource(file.path()));
    }

    /** 7.4 显式状态迁移(管理备用入口,迁移矩阵校验;cancelled 仅提交人本人) */
    @PutMapping("/{id}/status")
    public ExpenseDetailDto updateStatus(@PathVariable String id, @RequestBody StatusUpdateRequest request) {
        return service.updateStatus(Validators.requireUuid(id, "id"), request, CurrentUser.userId());
    }

    /** 7.5 写审批记录(落库并联动迁移:reject→rejected,approve 按 targetStatus→ongoing/approved,幂等) */
    @PostMapping("/{id}/approval-records")
    public ExpenseService.ApprovalResult addApprovalRecord(@PathVariable String id,
            @RequestBody ApprovalRecordRequest request) {
        return service.addApprovalRecord(Validators.requireUuid(id, "id"), request);
    }

    /** 7.6 写打款记录(状态必须 approved,写入即迁移 paid;重复调用 409) */
    @PostMapping("/{id}/payment")
    public PaymentDto addPayment(@PathVariable String id, @RequestBody PaymentRequest request) {
        return service.addPayment(Validators.requireUuid(id, "id"), request);
    }

    /** 7.7 撤回(仅提交人本人,仅 JWT) */
    @PostMapping("/{id}/cancel")
    public ExpenseDetailDto cancel(@PathVariable String id) {
        return service.cancel(Validators.requireUuid(id, "id"), requireUserId());
    }

    /** 7.8 列表查询(按 created_at 倒序分页) */
    @GetMapping
    public List<ExpenseSummaryDto> list(@RequestParam(required = false) String status,
            @RequestParam(required = false) String submitterId,
            @RequestParam(required = false) Integer offset,
            @RequestParam(required = false) Integer limit) {
        return service.list(status, submitterId, offset, limit);
    }

    /** 7.9 回写流程实例 id(幂等;不同 id 409) */
    @PutMapping("/{id}/process-instance")
    public ExpenseService.ProcessInstanceResult setProcessInstance(@PathVariable String id,
            @RequestBody ProcessInstanceRequest request) {
        return service.setProcessInstance(Validators.requireUuid(id, "id"), request);
    }

    // ==================== 内部 ====================

    /** 仅 JWT 端点的身份校验:服务密钥调用已被过滤器拦截,此处防御性再查一次 */
    private String requireUserId() {
        if (CurrentUser.isServiceCall() || CurrentUser.userId() == null) {
            throw new ForbiddenException("该端点仅接受用户 JWT 认证");
        }
        return CurrentUser.userId();
    }
}
