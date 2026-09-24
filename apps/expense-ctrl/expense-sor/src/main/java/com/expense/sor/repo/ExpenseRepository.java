package com.expense.sor.repo;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * SOR 五张表的数据访问(JdbcTemplate,表结构见 ddl/expense-schema.sql)。
 */
@Repository
public class ExpenseRepository {

    private final JdbcTemplate jdbc;

    public ExpenseRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ==================== 报销单主表 ====================

    public record ReportRow(UUID id, String title, String reason, BigDecimal totalAmount, String currency,
                            String status, String submitterId, String submitterName, String processInstanceId,
                            OffsetDateTime createdAt, OffsetDateTime updatedAt) {
    }

    private static final String REPORT_COLS =
            "id, title, reason, total_amount, currency, status, submitter_id, submitter_name, "
                    + "process_instance_id, created_at, updated_at";

    private static final RowMapper<ReportRow> REPORT_MAPPER = (rs, i) -> new ReportRow(
            rs.getObject("id", UUID.class),
            rs.getString("title"),
            rs.getString("reason"),
            rs.getBigDecimal("total_amount"),
            rs.getString("currency"),
            rs.getString("status"),
            rs.getString("submitter_id"),
            rs.getString("submitter_name"),
            rs.getString("process_instance_id"),
            rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("updated_at", OffsetDateTime.class));

    public ReportRow insertReport(String title, String reason, BigDecimal total,
                                  String submitterId, String submitterName) {
        return jdbc.queryForObject(
                "INSERT INTO expense_reports (title, reason, total_amount, currency, submitter_id, submitter_name) "
                        + "VALUES (?, ?, ?, 'CNY', ?, ?) RETURNING " + REPORT_COLS,
                REPORT_MAPPER, title, reason, total, submitterId, submitterName);
    }

    public Optional<ReportRow> findReportById(UUID id) {
        List<ReportRow> rows = jdbc.query(
                "SELECT " + REPORT_COLS + " FROM expense_reports WHERE id = ?", REPORT_MAPPER, id);
        return rows.stream().findFirst();
    }

    public int updateStatusFrom(UUID id, String from, String to) {
        return jdbc.update(
                "UPDATE expense_reports SET status = ?, updated_at = now() WHERE id = ? AND status = ?",
                to, id, from);
    }

    public int updateStatusIn(UUID id, List<String> fromStates, String to) {
        String placeholders = String.join(",", fromStates.stream().map(s -> "?").toList());
        Object[] args = new Object[2 + fromStates.size()];
        args[0] = to;
        args[1] = id;
        for (int i = 0; i < fromStates.size(); i++) {
            args[2 + i] = fromStates.get(i);
        }
        return jdbc.update(
                "UPDATE expense_reports SET status = ?, updated_at = now() WHERE id = ? AND status IN (" + placeholders + ")",
                args);
    }

    public int setProcessInstanceIfAbsent(UUID id, String processInstanceId) {
        return jdbc.update(
                "UPDATE expense_reports SET process_instance_id = ?, updated_at = now() "
                        + "WHERE id = ? AND process_instance_id IS NULL",
                processInstanceId, id);
    }

    public List<ReportRow> list(String status, String submitterId, int limit, int offset) {
        StringBuilder sql = new StringBuilder("SELECT " + REPORT_COLS + " FROM expense_reports WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (status != null && !status.isBlank()) {
            sql.append(" AND status = ?");
            args.add(status);
        }
        if (submitterId != null && !submitterId.isBlank()) {
            sql.append(" AND submitter_id = ?");
            args.add(submitterId);
        }
        sql.append(" ORDER BY created_at DESC, id LIMIT ? OFFSET ?");
        args.add(limit);
        args.add(offset);
        return jdbc.query(sql.toString(), REPORT_MAPPER, args.toArray());
    }

    // ==================== 报销明细 ====================

    public record ItemRow(UUID id, String category, BigDecimal amount, LocalDate occurredDate, String description) {
    }

    private static final RowMapper<ItemRow> ITEM_MAPPER = (rs, i) -> new ItemRow(
            rs.getObject("id", UUID.class),
            rs.getString("category"),
            rs.getBigDecimal("amount"),
            rs.getObject("occurred_date", LocalDate.class),
            rs.getString("description"));

    public void insertItem(UUID reportId, String category, BigDecimal amount, LocalDate occurredDate,
                           String description) {
        jdbc.update(
                "INSERT INTO expense_items (report_id, category, amount, occurred_date, description) "
                        + "VALUES (?, ?, ?, ?, ?)",
                reportId, category, amount, occurredDate, description);
    }

    public List<ItemRow> findItems(UUID reportId) {
        return jdbc.query(
                "SELECT id, category, amount, occurred_date, description FROM expense_items "
                        + "WHERE report_id = ? ORDER BY id",
                ITEM_MAPPER, reportId);
    }

    // ==================== 附件 ====================

    public record AttachmentRow(UUID id, UUID reportId, String fileName, String contentType, long sizeBytes,
                                String storagePath, String uploadedBy, OffsetDateTime createdAt) {
    }

    private static final RowMapper<AttachmentRow> ATTACHMENT_MAPPER = (rs, i) -> new AttachmentRow(
            rs.getObject("id", UUID.class),
            rs.getObject("report_id", UUID.class),
            rs.getString("file_name"),
            rs.getString("content_type"),
            rs.getLong("size_bytes"),
            rs.getString("storage_path"),
            rs.getString("uploaded_by"),
            rs.getObject("created_at", OffsetDateTime.class));

    public AttachmentRow insertAttachment(UUID reportId, String fileName, String contentType, long sizeBytes,
                                          String storagePath, String uploadedBy) {
        return jdbc.queryForObject(
                "INSERT INTO expense_attachments (report_id, file_name, content_type, size_bytes, storage_path, uploaded_by) "
                        + "VALUES (?, ?, ?, ?, ?, ?) "
                        + "RETURNING id, report_id, file_name, content_type, size_bytes, storage_path, uploaded_by, created_at",
                ATTACHMENT_MAPPER, reportId, fileName, contentType, sizeBytes, storagePath, uploadedBy);
    }

    public Optional<AttachmentRow> findAttachmentById(UUID attachmentId) {
        List<AttachmentRow> rows = jdbc.query(
                "SELECT id, report_id, file_name, content_type, size_bytes, storage_path, uploaded_by, created_at "
                        + "FROM expense_attachments WHERE id = ?",
                ATTACHMENT_MAPPER, attachmentId);
        return rows.stream().findFirst();
    }

    /** 建单时关联附件;仅当附件当前未关联任何单据时成功,返回受影响行数 */
    public int linkAttachment(UUID attachmentId, UUID reportId) {
        return jdbc.update(
                "UPDATE expense_attachments SET report_id = ? WHERE id = ? AND report_id IS NULL",
                reportId, attachmentId);
    }

    public List<AttachmentRow> findAttachments(UUID reportId) {
        return jdbc.query(
                "SELECT id, report_id, file_name, content_type, size_bytes, storage_path, uploaded_by, created_at "
                        + "FROM expense_attachments WHERE report_id = ? ORDER BY created_at, id",
                ATTACHMENT_MAPPER, reportId);
    }

    // ==================== 审批记录 ====================

    public record ApprovalRow(UUID id, UUID reportId, String processInstanceId, String activityId, String decision,
                              String comment, String approverId, String approverName, OffsetDateTime createdAt) {
    }

    private static final RowMapper<ApprovalRow> APPROVAL_MAPPER = (rs, i) -> new ApprovalRow(
            rs.getObject("id", UUID.class),
            rs.getObject("report_id", UUID.class),
            rs.getString("process_instance_id"),
            rs.getString("activity_id"),
            rs.getString("decision"),
            rs.getString("comment"),
            rs.getString("approver_id"),
            rs.getString("approver_name"),
            rs.getObject("created_at", OffsetDateTime.class));

    /**
     * 幂等写入审批记录(设计文档 §7.5):
     * 同 (process_instance_id, activity_id, approver_id) 重复调用不重复插入,
     * 冲突时返回空列表,由调用方置 duplicated=true。
     */
    public List<String> insertApprovalRecord(UUID reportId, String processInstanceId, String activityId,
                                             String decision, String comment, String approverId, String approverName) {
        return jdbc.queryForList(
                "INSERT INTO expense_approval_records "
                        + "(report_id, process_instance_id, activity_id, decision, comment, approver_id, approver_name) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (process_instance_id, activity_id, approver_id) DO NOTHING "
                        + "RETURNING id::text",
                String.class, reportId, processInstanceId, activityId, decision, comment, approverId, approverName);
    }

    public List<ApprovalRow> findApprovalRecords(UUID reportId) {
        return jdbc.query(
                "SELECT id, report_id, process_instance_id, activity_id, decision, comment, approver_id, approver_name, created_at "
                        + "FROM expense_approval_records WHERE report_id = ? ORDER BY created_at, id",
                APPROVAL_MAPPER, reportId);
    }

    // ==================== 打款记录 ====================

    public record PaymentRow(UUID id, UUID reportId, BigDecimal amount, String channel, String comment,
                             String paidBy, String paidName, OffsetDateTime paidAt) {
    }

    private static final RowMapper<PaymentRow> PAYMENT_MAPPER = (rs, i) -> new PaymentRow(
            rs.getObject("id", UUID.class),
            rs.getObject("report_id", UUID.class),
            rs.getBigDecimal("amount"),
            rs.getString("channel"),
            rs.getString("comment"),
            rs.getString("paid_by"),
            rs.getString("paid_name"),
            rs.getObject("paid_at", OffsetDateTime.class));

    /** 一单最多一条打款记录;冲突时返回空列表,由调用方返回 409(设计文档 §7.6) */
    public List<String> insertPayment(UUID reportId, BigDecimal amount, String channel, String comment,
                                      String paidBy, String paidName) {
        return jdbc.queryForList(
                "INSERT INTO expense_payments (report_id, amount, channel, comment, paid_by, paid_name) "
                        + "VALUES (?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (report_id) DO NOTHING "
                        + "RETURNING id::text",
                String.class, reportId, amount, channel, comment, paidBy, paidName);
    }

    public Optional<PaymentRow> findPayment(UUID reportId) {
        List<PaymentRow> rows = jdbc.query(
                "SELECT id, report_id, amount, channel, comment, paid_by, paid_name, paid_at "
                        + "FROM expense_payments WHERE report_id = ?",
                PAYMENT_MAPPER, reportId);
        return rows.stream().findFirst();
    }
}
