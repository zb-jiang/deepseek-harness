-- ============================================================
-- 费控报销 SOR 数据库结构 (PostgreSQL 13+)
-- 数据库名: expense (SOR 独占,不与其他系统共用)
-- 执行方式:
--   psql -U postgres -c "CREATE DATABASE expense;"
--   psql -U postgres -d expense -f expense-schema.sql
-- ============================================================

-- 报销单主表
CREATE TABLE expense_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT NOT NULL,                    -- 单据标题,如"9月差旅报销"
    reason        TEXT NOT NULL,                    -- 报销事由
    total_amount  NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),   -- 总金额=明细金额之和,SOR 校验
    currency      TEXT NOT NULL DEFAULT 'CNY',
    status        TEXT NOT NULL DEFAULT 'opened'
                  CONSTRAINT expense_reports_status_check
                  CHECK (status IN ('opened', 'ongoing', 'approved', 'rejected', 'paid', 'cancelled')),
    submitter_id   TEXT NOT NULL,                   -- 提交人 user_id(JWT sub)
    submitter_name TEXT NOT NULL,                   -- 提交人显示名(冗余,展示用)
    process_instance_id TEXT,                       -- 关联的流程实例 id(集成方流程启动后回写,可空)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 报销明细行
CREATE TABLE expense_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id    UUID NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
    category     TEXT NOT NULL,                     -- 费用类别:交通/住宿/餐饮/办公/其他
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    occurred_date DATE NOT NULL,                    -- 费用发生日期(yyyy-MM-dd)
    description  TEXT NOT NULL
);
CREATE INDEX idx_expense_items_report ON expense_items (report_id);

-- 发票等附件(文件本体存磁盘,这里存元数据)
CREATE TABLE expense_attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id    UUID REFERENCES expense_reports(id) ON DELETE CASCADE,  -- 可空:先独立上传,建单时经 linkAttachment 回填
    file_name    TEXT NOT NULL,                     -- 原始文件名
    content_type TEXT NOT NULL,                     -- MIME 类型
    size_bytes   BIGINT NOT NULL,
    storage_path TEXT NOT NULL,                     -- 磁盘相对路径(SOR 生成,如 {attachmentId}-{fileName})
    uploaded_by  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_attachments_report ON expense_attachments (report_id);

-- 审批记录(审计数据源;同一单据可产生多条)
CREATE TABLE expense_approval_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id           UUID NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
    process_instance_id TEXT NOT NULL,               -- 哪个流程实例产生的审批
    activity_id         TEXT NOT NULL,               -- 调用方的审批步骤标识(调用方定义并传入,如 "financeReview")
    decision            TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    comment             TEXT,                        -- 审批意见(可空)
    approver_id         TEXT NOT NULL,
    approver_name       TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 幂等约束:流程引擎失败重试会重放同一调用,同一实例同一节点同一人只允许一条
    UNIQUE (process_instance_id, activity_id, approver_id)
);
CREATE INDEX idx_expense_approvals_report ON expense_approval_records (report_id);

-- 打款记录(出纳完成打款后写入;一单最多一条)
CREATE TABLE expense_payments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id  UUID NOT NULL UNIQUE REFERENCES expense_reports(id) ON DELETE CASCADE,
    amount     NUMERIC(12,2) NOT NULL,
    channel    TEXT NOT NULL,                       -- 打款渠道:银行转账/现金/其他
    comment    TEXT,
    paid_by    TEXT NOT NULL,
    paid_name  TEXT NOT NULL,
    paid_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
