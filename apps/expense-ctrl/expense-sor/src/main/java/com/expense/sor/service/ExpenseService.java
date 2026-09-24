package com.expense.sor.service;

import com.expense.sor.exception.BadRequestException;
import com.expense.sor.exception.ConflictException;
import com.expense.sor.exception.NotFoundException;
import com.expense.sor.repo.ExpenseRepository;
import com.expense.sor.web.dto.ApprovalRecordDto;
import com.expense.sor.web.dto.ApprovalRecordRequest;
import com.expense.sor.web.dto.AttachmentMetaDto;
import com.expense.sor.web.dto.CreateExpenseRequest;
import com.expense.sor.web.dto.ExpenseDetailDto;
import com.expense.sor.web.dto.ExpenseItemDto;
import com.expense.sor.web.dto.ExpenseSummaryDto;
import com.expense.sor.web.dto.PaymentDto;
import com.expense.sor.web.dto.PaymentRequest;
import com.expense.sor.web.dto.ProcessInstanceRequest;
import com.expense.sor.web.dto.StatusUpdateRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * 报销单业务逻辑:
 * - 状态迁移入口收敛在 SOR 内部(设计文档 §6 规则 1):
 *   建单即 opened;ongoing/approved/rejected 由审批记录落库联动迁移(approve 按请求 targetStatus
 *   定目标——最后审批节点传 approved,其余传 ongoing;reject 固定 rejected);paid 由 payment
 *   写入即迁移;cancelled 走 cancel(仅 ongoing/approved)。
 * - 非法迁移 fail loud 返回 409 ILLEGAL_STATE_TRANSITION(§6 规则 2)。
 */
@Service
public class ExpenseService {

    private final ExpenseRepository repo;

    public ExpenseService(ExpenseRepository repo) {
        this.repo = repo;
    }

    // ==================== 7.1 创建报销单 ====================

    @Transactional
    public ExpenseDetailDto create(CreateExpenseRequest req, String submitterId) {
        if (req == null) {
            throw new BadRequestException("请求体不能为空");
        }
        String title = Validators.requireNonBlank(req.title(), "title");
        String reason = Validators.requireNonBlank(req.reason(), "reason");
        String submitterName = Validators.requireNonBlank(req.submitterName(), "submitterName");
        if (submitterId == null || submitterId.isBlank()) {
            throw new BadRequestException("缺少用户身份(JWT sub)");
        }
        if (req.items() == null || req.items().isEmpty()) {
            throw new BadRequestException("items 不能为空");
        }

        // 先校验并计算总额(= Σ 明细金额,不信任调用方传值,§7.1),再一次性落库
        BigDecimal total = BigDecimal.ZERO;
        for (CreateExpenseRequest.ItemInput item : req.items()) {
            if (item == null) {
                throw new BadRequestException("items 含空明细行");
            }
            Validators.requireNonBlank(item.category(), "items[].category");
            BigDecimal amount = Validators.requirePositiveAmount(item.amount(), "items[].amount");
            Validators.requireDate(item.occurredDate(), "items[].occurredDate");
            Validators.requireNonBlank(item.description(), "items[].description");
            total = total.add(amount);
        }
        total = total.setScale(2);

        List<String> attachmentIds = req.attachmentIds() == null ? List.of() : req.attachmentIds();

        ExpenseRepository.ReportRow report = repo.insertReport(
                title, reason, total, submitterId, submitterName);
        UUID reportId = report.id();

        for (CreateExpenseRequest.ItemInput item : req.items()) {
            repo.insertItem(reportId, item.category().trim(),
                    new BigDecimal(item.amount()), Validators.requireDate(item.occurredDate(), "items[].occurredDate"),
                    item.description().trim());
        }

        for (String attachmentId : attachmentIds) {
            UUID attId = Validators.requireUuid(attachmentId, "attachmentIds[]");
            var att = repo.findAttachmentById(attId)
                    .orElseThrow(() -> new BadRequestException("attachmentIds 含不存在的附件: " + attachmentId));
            if (att.reportId() != null) {
                throw new BadRequestException("附件已被其他单据关联: " + attachmentId);
            }
            if (repo.linkAttachment(attId, reportId) == 0) {
                throw new BadRequestException("附件关联失败(可能被并发关联): " + attachmentId);
            }
        }

        return getDetail(reportId);
    }

    // ==================== 7.3 查询 ====================

    @Transactional(readOnly = true)
    public ExpenseDetailDto getDetail(UUID reportId) {
        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));
        return toDetail(report);
    }

    @Transactional(readOnly = true)
    public List<ExpenseSummaryDto> list(String status, String submitterId, Integer offset, Integer limit) {
        if (status != null && !status.isBlank()) {
            Validators.requireState(status, "status");
        }
        int off = offset == null ? 0 : Math.max(0, offset);
        int lim = (limit == null || limit <= 0) ? 50 : Math.min(limit, 200);
        return repo.list(status, submitterId, lim, off).stream()
                .map(r -> new ExpenseSummaryDto(r.id().toString(), r.title(), r.reason(), r.totalAmount(),
                        r.currency(), r.status(), r.submitterId(), r.submitterName(), r.processInstanceId(),
                        r.createdAt()))
                .toList();
    }

    // ==================== 7.5 写审批记录(联动迁移) ====================

    public record ApprovalResult(String id, boolean duplicated) {
    }

    @Transactional
    public ApprovalResult addApprovalRecord(UUID reportId, ApprovalRecordRequest req) {
        if (req == null) {
            throw new BadRequestException("请求体不能为空");
        }
        String processInstanceId = Validators.requireNonBlank(req.processInstanceId(), "processInstanceId");
        String activityId = Validators.requireNonBlank(req.activityId(), "activityId");
        String decision = Validators.requireNonBlank(req.decision(), "decision");
        if (!"approve".equals(decision) && !"reject".equals(decision)) {
            throw new BadRequestException("decision 仅允许 approve/reject");
        }
        // JWT 调用时 approverId 必须等于当前 JWT sub,否则 403(§7.5);服务密钥调用以请求体为准(§4)
        String approverId = com.expense.sor.web.CurrentUser.resolveActorId(req.approverId(), "approverId");
        String approverName = Validators.requireNonBlank(req.approverName(), "approverName");

        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));

        List<String> inserted = repo.insertApprovalRecord(reportId, processInstanceId, activityId,
                decision, req.comment(), approverId, approverName);
        if (inserted.isEmpty()) {
            // 幂等重放:duplicated:true,不重复迁移(§7.5)
            return new ApprovalResult(null, true);
        }
        String recordId = inserted.get(0);

        // 联动迁移(§6 规则 1):reject → rejected;approve 按调用方声明的 targetStatus
        // (任一人首次审批 → ongoing,最后审批节点通过 → approved);已是目标态幂等跳过(ongoing 重放)
        String target;
        if ("reject".equals(decision)) {
            target = "rejected";
        } else if ("approved".equals(req.targetStatus())) {
            target = "approved";
        } else {
            target = "ongoing";
        }
        if (!report.status().equals(target)) {
            if (!Validators.ALLOWED_TRANSITIONS.getOrDefault(report.status(), java.util.Set.of()).contains(target)) {
                throw Validators.illegalTransition(report.status(),
                        "不允许从 " + report.status() + " 迁移到 " + target);
            }
            repo.updateStatusIn(reportId, List.of("opened", "ongoing"), target);
        }

        return new ApprovalResult(recordId, false);
    }

    // ==================== 7.6 写打款记录 ====================

    @Transactional
    public PaymentDto addPayment(UUID reportId, PaymentRequest req) {
        if (req == null) {
            throw new BadRequestException("请求体不能为空");
        }
        BigDecimal amount = Validators.requirePositiveAmount(req.amount(), "amount");
        String channel = Validators.requireNonBlank(req.channel(), "channel");
        String paidBy = com.expense.sor.web.CurrentUser.resolveActorId(req.paidBy(), "paidBy");
        String paidName = Validators.requireNonBlank(req.paidName(), "paidName");

        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));
        // 单据状态必须为 approved,否则 409(§7.6);非法迁移 fail loud(§6 规则 2)
        if (!"approved".equals(report.status())) {
            throw Validators.illegalTransition(report.status(), "仅 approved 状态可打款");
        }

        List<String> inserted = repo.insertPayment(reportId, amount, channel, req.comment(), paidBy, paidName);
        if (inserted.isEmpty()) {
            throw new ConflictException("打款记录已存在,不可重复打款");
        }
        // 写入打款记录即迁移到 paid(§6 规则 1)
        repo.updateStatusFrom(reportId, "approved", "paid");

        return repo.findPayment(reportId)
                .map(this::toPaymentDto)
                .orElseThrow(() -> new IllegalStateException("打款记录写入后读取失败"));
    }

    // ==================== 7.7 撤回 ====================

    @Transactional
    public ExpenseDetailDto cancel(UUID reportId, String currentUserId) {
        if (currentUserId == null || currentUserId.isBlank()) {
            throw new BadRequestException("缺少用户身份(JWT sub)");
        }
        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));
        // 仅提交人本人(§7.7)
        if (!currentUserId.equals(report.submitterId())) {
            throw new com.expense.sor.exception.ForbiddenException("仅提交人本人可撤回报销单");
        }
        // ongoing/approved 可撤,置 cancelled;opened/rejected/paid/cancelled 不可(§6/§7.7)
        if (!Validators.ALLOWED_TRANSITIONS.getOrDefault(report.status(), java.util.Set.of()).contains("cancelled")) {
            throw Validators.illegalTransition(report.status(), "仅 ongoing/approved 状态可撤回");
        }
        repo.updateStatusIn(reportId, List.of("ongoing", "approved"), "cancelled");
        return getDetail(reportId);
    }

    // ==================== 7.4 显式状态迁移(管理备用) ====================

    @Transactional
    public ExpenseDetailDto updateStatus(UUID reportId, StatusUpdateRequest req, String currentUserId) {
        if (req == null) {
            throw new BadRequestException("请求体不能为空");
        }
        String from = Validators.requireNonBlank(req.from(), "from");
        String to = Validators.requireNonBlank(req.to(), "to");
        if (!Validators.ALL_STATES.contains(from)) {
            throw new BadRequestException("from 非法,可选值: " + String.join("/", Validators.ALL_STATES));
        }
        // to 由迁移矩阵驱动:from 的合法目标集即允许集(§7.4;流程引擎 draft→opened 也走本端点)
        if (!Validators.ALLOWED_TRANSITIONS.getOrDefault(from, java.util.Set.of()).contains(to)) {
            throw new BadRequestException("to 非法,from=" + from + " 仅允许: "
                    + String.join("/", Validators.ALLOWED_TRANSITIONS.getOrDefault(from, java.util.Set.of())));
        }

        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));

        // cancelled 仅提交人本人可调(§7.4)
        if ("cancelled".equals(to)) {
            if (currentUserId == null || currentUserId.isBlank()) {
                throw new BadRequestException("迁移到 cancelled 需要用户身份(JWT)");
            }
            if (!currentUserId.equals(report.submitterId())) {
                throw new com.expense.sor.exception.ForbiddenException("仅提交人本人可撤回报销单");
            }
        }

        // 乐观校验:当前态 != from 返回 409 + details.current/expected(§7.4)
        if (!report.status().equals(from)) {
            throw new ConflictException("ILLEGAL_STATE_TRANSITION",
                    java.util.Map.of("current", report.status(), "expected", from));
        }
        // 合法性校验:状态机之外的一律 409(§6 规则 2)
        if (!Validators.ALLOWED_TRANSITIONS.getOrDefault(from, java.util.Set.of()).contains(to)) {
            throw Validators.illegalTransition(report.status(), "不允许从 " + from + " 迁移到 " + to);
        }
        if (repo.updateStatusFrom(reportId, from, to) == 0) {
            throw new ConflictException("ILLEGAL_STATE_TRANSITION",
                    java.util.Map.of("current", repo.findReportById(reportId)
                            .map(ExpenseRepository.ReportRow::status).orElse("unknown"),
                            "expected", from));
        }
        return getDetail(reportId);
    }

    // ==================== 7.9 回写流程实例 id ====================

    public record ProcessInstanceResult(String id, String processInstanceId, boolean firstWrite) {
    }

    @Transactional
    public ProcessInstanceResult setProcessInstance(UUID reportId, ProcessInstanceRequest req) {
        if (req == null) {
            throw new BadRequestException("请求体不能为空");
        }
        String pid = Validators.requireNonBlank(req.processInstanceId(), "processInstanceId");
        ExpenseRepository.ReportRow report = repo.findReportById(reportId)
                .orElseThrow(() -> Validators.notFound("报销单"));

        if (report.processInstanceId() == null) {
            repo.setProcessInstanceIfAbsent(reportId, pid);
            return new ProcessInstanceResult(reportId.toString(), pid, true);
        }
        if (report.processInstanceId().equals(pid)) {
            // 幂等:重复回写同一实例 id 返回 200(§7.9)
            return new ProcessInstanceResult(reportId.toString(), pid, false);
        }
        // 回写不同实例 id 返回 409:一单只关联一个流程实例(§7.9)
        throw new ConflictException("PROCESS_INSTANCE_CONFLICT",
                java.util.Map.of("current", report.processInstanceId(), "incoming", pid));
    }

    // ==================== DTO 组装 ====================

    private ExpenseDetailDto toDetail(ExpenseRepository.ReportRow r) {
        List<ExpenseItemDto> items = repo.findItems(r.id()).stream()
                .map(i -> new ExpenseItemDto(i.id().toString(), i.category(), i.amount(),
                        i.occurredDate(), i.description()))
                .toList();
        List<AttachmentMetaDto> attachments = repo.findAttachments(r.id()).stream()
                .map(a -> new AttachmentMetaDto(a.id().toString(), a.fileName(), a.contentType(),
                        a.sizeBytes(), a.uploadedBy(), a.createdAt()))
                .toList();
        List<ApprovalRecordDto> approvals = repo.findApprovalRecords(r.id()).stream()
                .map(this::toApprovalDto)
                .toList();
        PaymentDto payment = repo.findPayment(r.id()).map(this::toPaymentDto).orElse(null);
        return new ExpenseDetailDto(r.id().toString(), r.title(), r.reason(), r.totalAmount(), r.currency(),
                r.status(), r.submitterId(), r.submitterName(), r.processInstanceId(),
                items, attachments, approvals, payment, r.createdAt(), r.updatedAt());
    }

    private ApprovalRecordDto toApprovalDto(ExpenseRepository.ApprovalRow a) {
        return new ApprovalRecordDto(a.id().toString(), a.reportId().toString(), a.processInstanceId(),
                a.activityId(), a.decision(), a.comment(), a.approverId(), a.approverName(), a.createdAt());
    }

    private PaymentDto toPaymentDto(ExpenseRepository.PaymentRow p) {
        return new PaymentDto(p.id().toString(), p.reportId().toString(), p.amount(), p.channel(),
                p.comment(), p.paidBy(), p.paidName(), p.paidAt());
    }
}
