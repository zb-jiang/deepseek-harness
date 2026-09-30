# @acme-si/expense-sor-tools

Acme SI 实施交付——为汉云（Yunhan）员工端 DSH 提供费控 SOR（expense-sor）的 AI 工具包。

## 1. 能力裁剪表（业务评审结论，接入新 SOR 时照此格式填）

SOR 共 13 个端点（见 expense-sor `docs/API.md`），只暴露 5 个给 AI：

| 工具                              | SOR 端点                            | 暴露给 AI | 理由                            |
| ------------------------------- | --------------------------------- | ------ | ----------------------------- |
| `dsh_expense_create`            | 4 POST /api/expenses              | ✅      | 员工本人建单                        |
| `dsh_expense_list`              | 6 GET /api/expenses               | ✅      | 员工查自己的单                       |
| `dsh_expense_get`               | 7 GET /api/expenses/{id}          | ✅      | 审批读单核对（只读）                    |
| `dsh_expense_cancel`            | 12 POST /api/expenses/{id}/cancel | ✅      | SOR 已限制仅本人可撤                  |
| `dsh_expense_upload_attachment` | 5 POST /api/expenses/attachments  | ✅      | 员工上传发票                        |
| 状态迁移                            | 9 PUT /{id}/status                | ❌      | 管理备用入口，审计链须来自引擎               |
| 审批记录                            | 10 POST /{id}/approval-records    | ❌      | 审批审计只能来自流程引擎 delegate（服务密钥通道） |
| 打款                              | 11 POST /{id}/payment             | ❌      | 同上                            |
| 流程实例回写                          | 13 PUT /{id}/process-instance     | ❌      | 引擎 delegate 专用                |
| 下载附件                            | 8 GET /{id}/attachments/{aid}     | ❌（V1）  | 二进制流，模型无消费路径                  |
| 健康/ui-config/me                 | 1/2/3                             | ❌      | 平台/诊断用，非员工操作                  |



## 2. 产物形态：标准 DSH bundle（v0.2.0 起）

`node build.mjs` 产出单文件 `lib/index.js`（ESM），其中：

- `@deepseek-ai/dsh-tools`（defineTool，纯 JS）→ **内联**
- `@deepseek-ai/schemastery`（Config schema）→ **内联**（loader 经 Standard Schema `~standard.validate` 鸭子类型调用，内联副本行为一致）
- `@deepseek-ai/cordis` → 仅 `import type`，编译期擦除，运行时不存在

v0.2.0 起包为**标准 bundle 形态**（`package.json` 声明 `dsh.bundle.patch` 指向包内自带的 `cordis.patch.yml`，其中显式声明 `sorBaseUrl`），直接走官方插件安装通道：

- **热安装**：官方"添加插件"对话框 / `dsh plugin add` 装完即热生效（无需重启）
- **热卸载**：插件管理页停用即摘除（无需重启）
- **升级需重启**：官方硬限制（ESM 模块缓存无法原地替换），界面会提示
- **版本门禁**：`engines.dsh`（当前 `>=0.2.0-rc.1`）不匹配时安装被明确拦下

## 3. 构建

```bash
# 开发机（有 deepseek-harness 检出，默认 DEPS=workspace）
node build.mjs

# 真实实施环境：私有 registry 安装依赖后自然解析
npm i -D esbuild @deepseek-ai/dsh-tools @deepseek-ai/schemastery
DEPS=registry node build.mjs
```

构建后自检（可选但强烈建议）：

```bash
node -e "import('./lib/index.js').then(m => { const t=[]; m.apply({tools:{register:x=>t.push(x)},currentUser:{getToken:()=>'x'}},{sorBaseUrl:{get:()=>'http://x'}}); console.log(t.map(x=>x.name)) })"
# 期望输出 5 个 dsh_expense_* 工具名
```

## 4. 部署（员工端 DSH，单机）

前提：员工端已能正常登录（enterprise profile 就绪）、费控 SOR 已启动（默认 `http://127.0.0.1:8091`，即包内 `cordis.patch.yml` 声明的地址——地址一致则装完零配置）。

### 安装（官方插件通道，任选其一）

- **图形界面**：DSH 员工端设置 → 插件管理 → "添加插件" → 本地目录，选择本包目录（或发到私有 registry 后填包名 `@acme-si/expense-sor-tools`）
- **命令行**：`dsh plugin add <本地目录或包名> --profile enterprise`

装完即热生效，无需重启。验证：对话里说"查一下我最近的报销单"，AI 应以工具卡片形式调用 `dsh_expense_list`。

> **从 v0.1.x 手工安装升级上来的机器**：先做两步清理再走官方安装——① 删除 profile `cordis.patch.yml` 里手工加的 `expense-sor-tools` insert 条目；② 删除 `profiles\enterprise\node_modules\@acme-si\` 整个目录（手工拷贝不受 pnpm 管理，会与新安装冲突）。

### 卸载 / 停用

插件管理页停用即热摘除（补丁随包走，无需手改 yml）。

## 5. 配置 sorBaseUrl（地址不同的机器）

**默认值在包内 `cordis.patch.yml` 的 config 段**（开发 bundle 时已确定）：`http://127.0.0.1:8091`；Config schema 里另有同值默认兜底（删掉 yml 的 config 段时生效）。

某台机器的 SOR 地址不同时，在该机器 profile 用户补丁层（`%USERPROFILE%\.dsh\profiles\enterprise\cordis.patch.yml`）加一条**定点覆盖**行——目标 id 已存在（bundle 已装），覆盖其配置：

```yaml
- id: expense-sor-tools
  config:
    sorBaseUrl: http://实际地址:端口
```

覆盖行**不随包升级丢失**（包升级只动包本身，用户补丁层是机器本地的）；改完热重载生效。**不要直接改包内 `cordis.patch.yml`**——包升级时会被新版本冲掉；要改默认值应改包源码重新发版。

## 6. 目录结构

```
expense-sor-tools/
├── package.json        # dsh.bundle.patch + engines.dsh 版本门禁；零 dependencies
├── cordis.patch.yml    # 包内自带补丁（insert 行 + sorBaseUrl 默认值）
├── build.mjs           # esbuild 单文件内联构建
├── src/index.ts        # 插件源码（5 工具 + Config 默认值）
├── lib/index.js        # 构建产物
└── README.md
```