# 费控报销 SOR (System of Record)

独立运行的费控报销业务数据唯一权威系统:Java 17 + Spring Boot 3.x + PostgreSQL 15+ + Maven,REST API 端口 8091(路径前缀 `/api`)。

按《2026-09-22 费控报销 SOR 开发规格书》实现,覆盖:

- **数据模型**(§5):`expense_reports` / `expense_items` / `expense_attachments` / `expense_approval_records` / `expense_payments` 五张表
- **状态机**(§6):`submitted → approved → paid`,`submitted → rejected`,`submitted/approved → cancelled`;迁移入口收敛在 SOR 内部(审批记录落库联动迁移、打款写入即迁移),非法迁移 fail loud 返回 409
- **认证**(§4):JWT(JWKS 验签,校验签名/iss/exp,不校验 aud)+ `X-Service-Key` 服务间调用(仅限读单/显式迁移/回写流程实例/审批记录/打款五个端点)
- **API**(§7):建单、附件上传/下载、读单、显式状态迁移、审批记录(幂等)、打款(幂等)、撤回、列表、流程实例回写(幂等)
- **错误码**(§10):统一信封 `{"code":...,"data":...}` / `{"code":1400/1401/1403/1404/1409/1500,"message":...,"details":...}`

## 目录结构

```
expense-sor/
├── pom.xml                       # Maven 构建(Spring Boot 3.3.5, Java 17)
├── ddl/expense-schema.sql        # 数据库 DDL(设计文档 §5 原样)
├── docs/INSTALL-AND-SETUP.md     # ★ 安装与配置手册(PG 安装/初始化/环境变量/启动/自测)
├── src/main/java/com/expense/sor/
│   ├── config/                   # 安全配置、服务密钥过滤器、应用配置项
│   ├── exception/                # 业务异常体系(400/403/404/409)
│   ├── repo/                     # JdbcTemplate 数据访问(五张表)
│   ├── service/                  # 状态机与业务逻辑、附件存储、校验工具
│   └── web/                      # REST 控制器、统一信封、全局异常、身份工具
├── tools/test-auth/auth-server.js# 测试专用认证中心(JWKS+签发 JWT,生产禁用)
├── acceptance/run-acceptance.mjs # 验收自测脚本(§12 清单 1-9 自动化,10/11 人工)
└── acceptance/ACCEPTANCE-RECORD.md
```

## 快速开始

完整步骤见 **[docs/INSTALL-AND-SETUP.md](docs/INSTALL-AND-SETUP.md)**(含 PostgreSQL 安装与初始化)。摘要:

```bash
# 1. 初始化数据库(手工)
psql -U postgres -c "CREATE DATABASE expense;"
psql -U postgres -d expense -f ddl/expense-schema.sql

# 2. 构建
mvn package -DskipTests

# 3. 配置环境变量(SOR_DB_*, SOR_JWKS_URL, SOR_JWT_ISSUER, SOR_ATTACHMENT_DIR, SOR_SERVICE_KEY)
#    详见 docs/INSTALL-AND-SETUP.md §3.2

# 4. 启动测试认证中心(自测用)与应用
node tools/test-auth/auth-server.js          # 终端 1
java -jar target/expense-sor-1.0.0.jar       # 终端 2

# 5. 验收自测
node acceptance/run-acceptance.mjs
```

## API 一览

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 无 | 健康检查 `{"status":"UP"}` |
| POST | `/api/expenses` | JWT | 创建报销单(创建即 submitted,totalAmount 由 SOR 计算) |
| POST | `/api/expenses/attachments` | JWT | 上传附件(multipart,字段 `file`,≤10MB,pdf/png/jpeg) |
| GET | `/api/expenses/{id}` | JWT 或 ServiceKey | 查询单据(含明细/附件/审批记录/打款记录) |
| GET | `/api/expenses/{id}/attachments/{attachmentId}` | JWT 或 ServiceKey | 下载附件本体 |
| PUT | `/api/expenses/{id}/status` | JWT 或 ServiceKey | 显式状态迁移(管理备用,`from` 乐观校验) |
| POST | `/api/expenses/{id}/approval-records` | JWT 或 ServiceKey | 写审批记录(幂等;落库联动迁移 approved/rejected) |
| POST | `/api/expenses/{id}/payment` | JWT 或 ServiceKey | 写打款记录(须 approved,写入即 paid,重复 409) |
| POST | `/api/expenses/{id}/cancel` | JWT | 撤回(仅提交人本人,submitted/approved 可撤) |
| GET | `/api/expenses?status=&submitterId=&offset=&limit=` | JWT | 列表(created_at 倒序分页) |
| PUT | `/api/expenses/{id}/process-instance` | JWT 或 ServiceKey | 回写流程实例 id(同 id 幂等,不同 id 409) |
