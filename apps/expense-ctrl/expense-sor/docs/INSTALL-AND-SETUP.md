# 费控报销 SOR —— 安装与配置手册

> 适用对象:负责部署、初始化与自测 SOR 的工程师。
> 本手册覆盖:环境依赖 → PostgreSQL 安装与初始化(手工执行)→ 应用配置 → 启动 → 验收自测。

---

## 1. 环境依赖

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| JDK | 17+ | 编译与运行必需(Oracle JDK 17/21、OpenJDK 均可) |
| Maven | 3.9+ | 仅构建时需要,运行时只需 JAR 包 |
| PostgreSQL | 15+(13+ 亦可,需支持 `gen_random_uuid()`) | SOR 独占数据库 `expense` |
| Node.js | 18+(可选) | 仅运行**测试专用认证中心**与**自动验收脚本**时需要 |

> 说明:SOR 使用独立数据库 `expense`,PG 实例可与其他系统同机共用,也可完全独立部署。

---

## 2. PostgreSQL 安装与初始化(手工执行)

### 2.1 安装 PostgreSQL(已有实例可跳过)

若本机尚未安装 PostgreSQL:

1. 访问 https://www.postgresql.org/download/windows/ ,下载 EnterpriseDB 安装包(推荐 16/17/18)。
2. 运行安装器,关键选项:
   - **超级用户口令**:为 `postgres` 用户设置密码(下文以 `<PG_PASSWORD>` 代指,请替换为实际值);
   - **端口**:默认 `5432`;
   - **Locale**:默认即可。
3. 安装完成后确认服务已启动:

   ```powershell
   Get-Service | Where-Object { $_.Name -match 'postgres' }
   # 期望看到 postgresql-x64-XX 状态为 Running
   ```

> 本机如已安装 PostgreSQL 18(服务名 `postgresql-x64-18`,默认路径 `D:\Program Files\PostgreSQL\18`),可直接进入 2.2 初始化。

### 2.2 创建数据库

```powershell
# 进入 psql(在 PATH 中时直接用 psql;否则用完整路径)
$env:PGPASSWORD = "<PG_PASSWORD>"
& "D:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d postgres -c "CREATE DATABASE expense;"
```

> Linux/macOS:`psql -h localhost -U postgres -d postgres -c "CREATE DATABASE expense;"`

### 2.3 执行 DDL(建五张表)

```powershell
& "D:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d expense -f ddl\expense-schema.sql
```

成功标志:依次输出 5 个 `CREATE TABLE` 与 3 个 `CREATE INDEX`。

### 2.4 创建附件目录

```powershell
New-Item -ItemType Directory -Force -Path "D:\data\expense-sor\attachments"
```

### 2.5 验证数据库就绪

```powershell
& "D:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d expense -c "\dt"
# 应列出 expense_reports / expense_items / expense_attachments / expense_approval_records / expense_payments 五张表
```

---

## 3. 应用配置

### 3.1 PowerShell 启动配置示例

```powershell
$env:SOR_DB_HOST = "localhost"
$env:SOR_DB_PORT = "5432"
$env:SOR_DB_NAME = "expense"
$env:SOR_DB_USER = "postgres"
$env:SOR_DB_PASSWORD = "<PG_PASSWORD>"
$env:SOR_JWKS_URL = "https://tmommaaeuqnhanbtqmti.supabase.co/auth/v1/.well-known/jwks.json"
$env:SOR_JWT_ISSUER = "https://tmommaaeuqnhanbtqmti.supabase.co/auth/v1"
$env:SOR_ATTACHMENT_DIR = "D:/data/expense-sor/attachments"
$env:SOR_SERVICE_KEY = "demo-service-key"
```

前置条件(平台侧确认,非 SOR 侧改动):

1. Supabase 项目的 Authentication → JWT Keys 使用 **asymmetric signing keys(ES256)**;若仍是 legacy HS256 shared-secret 模式,JWKS 端点不可用,需先在 dashboard 迁移到 asymmetric keys
2. SOR 所在服务器可出公网访问 `*.supabase.co`(HTTPS 443)
应用已同时支持 RS256(自测认证中心)与 ES256(Supabase)两种签名算法,切环境无需改代码或配置项。

---

## 4. 构建

```bash
cd expense-sor
mvn package -DskipTests
# 产物: target/expense-sor-1.0.0.jar
```

---

## 5. 启动

### 5.1 自测形态

```bash
java -jar target/expense-sor-1.0.0.jar
# 启动成功后: GET http://localhost:8091/api/health -> {"status":"UP"}
```
