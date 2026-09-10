# SkillHub 源码部署与配置手册（企业级 Skill 仓库 · 工作项 1）

> 目的：在 Windows 64 位机器上以**源码方式**部署自托管 [SkillHub](https://github.com/iflytek/skillhub)（讯飞开源的企业级 Agent Skill 注册中心），完成企业级 skill 的发布、版本与治理闭环，替代手工复制 SKILL.md 到 `%USERPROFILE%\.dsh\skills\` 的做法。选择源码部署的原因：需要修改 logo 与功能定制。
> 设计决策与后续自动分发（daemon 预装、待办即时安装）见 [2026-09-09-skill-repo-design.md](2026-09-09-skill-repo-design.md)。
> 上游项目：<https://github.com/iflytek/skillhub>（Apache-2.0 许可，第三方项目，非 DSH 官方组件）。上游文档：<https://iflytek.github.io/skillhub/>。

## 1. SkillHub 是什么

一句话：**skill 包的「私有 npm 仓库 + 管理后台」**。它管理标准 Agent Skills 格式的技能包（`SKILL.md` + YAML frontmatter + 配套文件），而这个格式与 DSH 的 skill 格式完全同源——所以 DSH 的 skill 目录可以直接发布进去，发布出来的包也能直接装给 DSH 用。

本平台用它获得的能力（对应 [设计文档](2026-09-09-skill-repo-design.md) 工作项 1 的需求）：

| 需求           | SkillHub 对应能力                                                  |
| ------------ | -------------------------------------------------------------- |
| 上传 / 更新 / 删除 | Web UI 发布 + CLI `publish` / `remove --remote`                  |
| 版本控制         | 语义化版本 + `beta` / `stable` 标签 + `latest` 自动追踪                   |
| 管理界面         | 自带 Web UI（搜索、详情、版本历史、下载统计）                                     |
| 审核治理         | 命名空间（Owner/Admin/Member）+ 分级审核 + 审计日志                          |
| 访问控制         | 可见性 `public` / `namespace-only` / `private` + scoped API token |
| 安全           | Skill Scanner 多引擎扫描（可选启用）+ 上传扩展名白名单                            |

## 2. 源码仓库结构

```text
skillhub/
├── server/    后端，Java 21+ / Spring Boot 3 多模块 Maven（含 mvnw.cmd，无需预装 Maven）
├── web/       Web UI，React 19 + TypeScript + Vite + pnpm
├── cli/       CLI 工具（发布/安装用，员工 PC 走 npm 安装，无需本仓库源码）
├── scanner/   安全扫描服务（Python 独立服务，可选，本手册默认禁用）
└── docs/      上游文档站（VitePress）
```

## 3. 前置要求（部署机）

| 软件         | 版本要求          | 说明                                                                                                                                              |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| JDK        | **21+**（硬性要求） | 本机已有的 Java 17（`D:\Java`）不满足；另装一个 JDK 21（推荐 [Adoptium Temurin 21](https://adoptium.net/) MSI），与 Java 17 共存、按会话切换 `JAVA_HOME`，不影响 flowable-engine |
| Node.js    | 20+ LTS       | 前端构建用                                                                                                                                           |
| pnpm       | 最新即可          | `npm install -g pnpm`                                                                                                                           |
| Git        | 任意近期版本        | 克隆源码                                                                                                                                            |
| PostgreSQL | 16            | 见 §4.1                                                                                                                                          |
| Redis      | 7.x 兼容即可      | 用社区 Windows 编译版，见 §4.2                                                                                                                          |

版本自查：

```powershell
java -version    # 必须 21+
node -v          # v20+
pnpm -v
```

## 4. 中间件安装

后端真正依赖的只有 PostgreSQL 和 Redis 两个；MinIO 不需要（默认本地文件系统存储），scanner 可禁用（§6 启动时用环境变量关掉）。

### 4.1 PostgreSQL 16

1. 下载安装：[postgresql.org Windows 安装包](https://www.postgresql.org/download/windows/)（EDB 安装器，x64）。安装时记住 `postgres` 超级用户密码；端口保持默认 5432。
2. 建库建用户（凭据与 SkillHub `application-local.yml` 默认值一致，后端零配置直连）：

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost
```

```sql
CREATE USER skillhub WITH PASSWORD 'skillhub_dev';
CREATE DATABASE skillhub OWNER skillhub;
\q
```

表结构不用手工建——后端首次启动时 Flyway 自动迁移建表。若想用别的凭据/端口，启动时用环境变量覆盖：`SPRING_DATASOURCE_URL` / `SPRING_DATASOURCE_USERNAME` / `SPRING_DATASOURCE_PASSWORD`。

**注意**：SkillHub 用自己的库，别把它指向 Supabase 的 PG 实例（`ddl-auto: validate` + Flyway 会往库里写自己的表，与 Supabase 的 public schema 混在一起）。

### 4.2 Redis

Redis 官方只发 Linux/macOS 版，Windows 上用社区原生编译版 [redis-windows/redis-windows](https://github.com/redis-windows/redis-windows/)：GitHub Actions 用官方源码自动编译，7.x/8.x 都有，解压即用。非官方构建、无安全更新承诺，但 SkillHub 只把 Redis 当缓存/队列，开发/试用环境风险可控。

步骤：

1. 到 [Releases 页](https://github.com/redis-windows/redis-windows/releases) 下载最新 zip，解压到固定目录，如 `D:\redis`。解压后应包含 `redis-server.exe`、`redis-cli.exe`、`redis.conf`（服务版还有 `RedisService.exe`）。
2. 注册为 Windows 服务（管理员 PowerShell；`RedisService.exe` 是该项目推荐的常驻方式，自动处理路径转换）：

```powershell
cd D:\redis
.\RedisService.exe install -c D:\redis\redis.conf --dir D:\redis\data --port 6379
net start Redis
```

卸载服务用 `.\RedisService.exe uninstall`。zip 里没有 `RedisService.exe`、或它缺 .NET 运行时起不来时，退回前台方式：`.\redis-server.exe redis.conf`（窗口开着就在跑，另开终端验证）。

验证：

```powershell
.\redis-cli.exe ping   # 返回 PONG 即可
```

**路径坑**：`redis-server.exe` 用 Cygwin 运行时编译，命令行传路径必须是 Cygwin 格式（`D:\x` 写成 `/cygdrive/d/x`），Windows 绝对路径会报 `can't open config file`；`redis.conf` 文件内部则推荐写正斜杠（如 `dir D:/redis/data`）。走 `RedisService.exe` 或相对路径可完全避开。

默认 `localhost:6379` 无密码，与后端默认配置一致；如有密码用 `SPRING_DATA_REDIS_PASSWORD` 覆盖。

### 4.3 明确不需要的组件

- **MinIO / 对象存储**：`skillhub.storage.provider` 默认 `local`（本地文件系统），skill 包落在 `STORAGE_BASE_PATH` 指定的目录（§6）。
- **Skill Scanner**：独立 Python 服务，企业部署不跑。注意上游设计：`public` / `namespace-only` 可见性的 skill 发布**必须**先过安全扫描（`SkillPublishService.requiresSecurityScanner`，无配置可绕过）。企业 fork 已做两处放宽（`application-local.yml`）：扫描器默认关闭（`enabled` 默认 `false`），并新增 `skillhub.security.scanner.required-for-publish=false` 豁免发布强扫——这是 fork 相对上游的核心定制点之一，同步上游时留意。将来要启用再按上游 `scanner/` 目录文档部署。

## 5. 获取源码

```powershell
# 建议先 fork 到企业自己的 Git 仓库再克隆（定制 logo/功能要进版本管理，且方便跟上游同步）
git clone https://github.com/iflytek/skillhub.git D:\works\enterprise-skillhub
cd D:\works\enterprise-skillhub
```

## 6. 构建并启动后端

### 6.1 Maven 国内镜像（一次性）

项目自带阿里云镜像配置但 Maven 不会自动读项目级配置，复制到用户目录：

```powershell
Copy-Item D:\works\enterprise-skillhub\server\.mvn\settings.xml $env:USERPROFILE\.m2\settings.xml
```

（目录不存在先 `mkdir $env:USERPROFILE\.m2`。）

### 6.2 切换 JDK 21 并构建

```powershell
# 按实际安装路径调整；本会话内生效，不影响系统默认 Java 17
$env:JAVA_HOME = "D:\jdk-21"
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
java -version   # 确认 21+

cd D:\works\enterprise-skillhub\server
.\mvnw.cmd -pl skillhub-app -am clean package -DskipTests
```

首次构建要下载依赖，几分钟属正常。

### 6.3 启动（local profile）

```powershell
# 环境变量按需调整；扫描器与内置演示 skill 在企业 fork 的 local profile 已默认关闭，无需再设
$env:STORAGE_BASE_PATH = "D:\works\enterprise-skillhub\skillhub-storage"          # skill 包存储目录（默认 /tmp/... 在 Windows 不合适）
$env:BOOTSTRAP_ADMIN_PASSWORD = "passw0rd"           # 内置管理员密码（也可登录后在 UI 改）

java -jar skillhub-app\target\skillhub-app-0.1.0.jar --spring.profiles.active=local --server.port=8095
```

`--server.port=8095` 的原因：后端默认 8080，与 web-console 冲突，统一改 8095（端口总览见 §6.4）。启动日志出现 `Started SkillhubAppApplication` 即就绪；首次启动 Flyway 会自动建表。

### 6.4 端口总览

| 服务              | 端口       | 说明                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------- |
| SkillHub Web UI | 3000     | Vite 开发服务器，§7 启动                                                           |
| SkillHub 后端 API | **8095** | 用 `--server.port` 从默认 8080 改过来，避开 web-console                              |
| PostgreSQL      | 5432     | §4.1                                                                       |
| Redis           | 6379     | §4.2                                                                       |
| web-console     | 8080（已有） | 见 [2026-08-19-supabase-setup-guide.md](2026-08-19-supabase-setup-guide.md) |
| flowable-engine | 8090（已有） | —                                                                          |

## 7. 启动前端

前端开发服务器默认把 `/api`、`/oauth2` 代理到 `http://localhost:8080`，后端已改 8095，先改代理（文件 [web/vite.config.ts](file:///D:/works/enterprise-skillhub/web/vite.config.ts) 底部 `server.proxy` 两处 target）：

```typescript
proxy: {
  '/api': {
    target: 'http://localhost:8095',
    changeOrigin: true,
  },
  '/oauth2': {
    target: 'http://localhost:8095',
    changeOrigin: true,
  },
},
```

然后启动：

```powershell
cd D:\works\enterprise-skillhub\web
pnpm install
pnpm exec vite --host 127.0.0.1 --port 3000
```

Vite 带热更新——改 logo、改界面保存即生效，是定制开发的主工作模式。

## 8. 部署验证

- 浏览器打开 `http://localhost:3000`：出现 SkillHub 首页即 Web UI 正常。
- 后端 API 探活：`curl http://localhost:8095`（注意不是 8090），返回 JSON（非连接拒绝）即正常；API 文档在 `http://localhost:8095/swagger-ui.html`。
- 登录 Web UI：管理员 `admin` + 启动时设的 `BOOTSTRAP_ADMIN_PASSWORD`（未设则上游默认 `ChangeMe!2026`，登录后立即在个人设置改掉）。
- 本地开发免登录捷径：local profile 开了 mock 用户，浏览器装 ModHeader 之类插件加请求头 `X-Mock-User-Id: local-admin` 即可以超管身份浏览。

## 10. 生产化配置

试用够用之后、正式对员工端分发前确认以下几项：

- **管理员密码**：`BOOTSTRAP_ADMIN_PASSWORD` 已改强密码；不需要内置账号则设 `BOOTSTRAP_ADMIN_ENABLED=false` 走注册/邀请流程。
- **对外访问**：员工端/其他机器要访问时，前端改 `pnpm exec vite --host 0.0.0.0`（局域网可访问的试用形态），并给后端加环境变量 `SKILLHUB_PUBLIC_BASE_URL=http://<本机IP>:3000`（Web UI 展示的安装命令、指引靠它拼 URL）。
- **正式常驻形态**：Vite 开发服务器不适合长期生产。正式形态为 `pnpm run build` 产出 `web/dist/` 静态文件，用 nginx/IIS 托管并把 `/api`、`/oauth2` 反向代理到 8095（参考上游 `compose.release.yml` 里 web 服务的 nginx 配置）；后端 jar 用 [NSSM](https://nssm.cc/) 注册为 Windows 服务开机自启。
- **上传扩展名白名单**：默认清单含 `.md`、`.json`、办公文档等（上游 `SkillPackagePolicy.java`）。DEMO 的 6 个 skill 只有 SKILL.md，默认够用；将来要带 `.py` / `.ps1` 脚本时用环境变量**整体替换**（非追加）并评估风险：

```powershell
$env:SKILLHUB_PUBLISH_ALLOWED_FILE_EXTENSIONS = ".md,.json,.py,.ps1"
```

## 11. 治理结构初始化（发布前一次性做）

1. **管理员登录** Web UI（`admin`，已改密码），确认「平台管理」可用。
2. **建命名空间**：按使用方建，本平台 DEMO 建 `dsh-demo`；将来按部门建 `finance`、`hr` 等。命名空间是权限与可见性的单位——Owner/Admin/Member 三级角色，Admin 负责本空间内审核。
3. **拉成员**：把流程设计者加为对应命名空间的 Member（可发布，需审核）或 Admin。
4. **定可见性策略**：企业内部一律 `namespace-only`（仅命名空间成员可见），禁止 `public`。
5. **签发 API token**：Web UI 个人设置 → API 令牌，生成两枚——
   - 给 web-console 后端的**读 token**（设计器下拉、发布校验用）；
   - 给员工端 skill-sync 的**只读分发 token**（search/install 用，禁 publish/delete）。
     token 只显示一次，妥善保存；用途与分级详见 [设计文档 §9](2026-09-09-skill-repo-design.md)。

## 12. 安装 SkillHub CLI 并发布 DEMO 的 6 个 skill

以下在**员工 PC**（Windows + PowerShell）执行。DEMO 的 6 个 skill 目录已存在于 `%USERPROFILE%\.dsh\skills\`（[2026-09-05-e2e-demo-design.md](2026-09-05-e2e-demo-design.md) §1.4 手工放置的），直接把它们发布入库。

### 12.1 安装 CLI 并登录

```powershell
npm install -g @astron-team/skillhub

# registry 地址：填后端 API（本机部署即 localhost:8095；他机部署填 <IP>:8095）
skillhub login --token sk_你的token --registry http://localhost:8095

# 验证身份
skillhub whoami
```

registry 解析优先级：`--registry` 参数 > `SKILLHUB_REGISTRY` 环境变量 > `~/.skillhub/config.json`。登录一次后凭据存 `~/.skillhub/credentials.json`，后续命令不用再带。

### 12.2 发布（逐个执行）

```powershell
cd $env:USERPROFILE\.dsh\skills

skillhub publish .\expense-form-assistant  --namespace dsh-demo --visibility namespace-only
skillhub publish .\direct-manager-approver --namespace dsh-demo --visibility namespace-only
skillhub publish .\dept-manager-approver   --namespace dsh-demo --visibility namespace-only
skillhub publish .\cfo-final-approver      --namespace dsh-demo --visibility namespace-only
skillhub publish .\invoice-verifier        --namespace dsh-demo --visibility namespace-only
skillhub publish .\cashier-payment         --namespace dsh-demo --visibility namespace-only
```

发布成功后终端会给出 skill 详情页 URL；也可在 Web UI 搜索确认。首次发布默认版本 1.0.0；如果命名空间开了审核，Member 发布需等 Admin 通过。

### 12.3 后续更新与删除

```powershell
# 更新：改完 SKILL.md 后重新 publish，版本号递增（SKILL.md frontmatter 里写 version: 1.1.0，
# 或用 CLI 参数指定），SkillHub 自动追踪 latest
skillhub publish .\expense-form-assistant --namespace dsh-demo

# 删除远端 skill（需写权限 token 或在 Web UI 操作；非交互环境加 --hard）
skillhub remove expense-form-assistant --remote --namespace dsh-demo
```

## 13. 员工端手动安装验证（阶段一闭环）

自动分发（skill-sync）落地前，员工端先用 CLI 手动装到 DSH 的 skill 目录验证闭环——这一步同时就是「仓库 → 安装 → 待办可用」的验收：

```powershell
# 已 login 过（§12.1）。装到 DSH 用户级 skill 目录
skillhub install expense-form-assistant  --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"
skillhub install direct-manager-approver --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"
skillhub install dept-manager-approver   --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"
skillhub install cfo-final-approver      --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"
skillhub install invoice-verifier        --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"
skillhub install cashier-payment         --namespace dsh-demo --dir "$env:USERPROFILE\.dsh\skills"

# 查看已装清单（来源、版本一目了然）
skillhub list --dir "$env:USERPROFILE\.dsh\skills"

# 检查更新（只预览不落盘）
skillhub upgrade --check
```

验证要点：

- `--dir` 指定安装目录时不与 `--agent` / `--scope` 同用；装完目录里每个 skill 下多出 `.skillhub\metadata.json`（来源 registry/namespace/version/fingerprint 溯源，重发布时会被自动排除）。
- 打开员工端 DSH（enterprise profile），进「员工提交报销单」待办的 AI 会话，确认 skill 目录包含 `expense-form-assistant`（系统提示词中的 skill catalog 可见）。
- demo 的 BPMN `dsh:skillRef` 用的是裸 skill 名，安装时 skill 包名一致即可，流程定义无需任何改动。

## 14. 常见问题

- **Maven 构建报「无效的源发行版 21」或编译错误**：当前会话 `JAVA_HOME` 还指向 Java 17，按 §6.2 切到 JDK 21（`java -version` 确认）。
- **Maven 依赖下载超时**：确认 §6.1 的阿里云镜像已复制到 `%USERPROFILE%\.m2\settings.xml`。
- **启动报 PostgreSQL 连接失败/认证失败**：PG 服务没起（`services.msc` 查 `postgresql-x64-16`）；或 §4.1 的 `skillhub` 用户/库没建；或用了非默认凭据但没设 `SPRING_DATASOURCE_*` 环境变量。
- **启动报 Redis 连接失败**：§4.2 的服务没起（`redis-cli ping` 验证）。
- **社区版 Redis 报** **`can't open config file`**：Cygwin 路径格式问题，命令行别给 `redis-server.exe` 传 Windows 绝对路径（§4.2「路径坑」）。
- **前端页面能开但登录/搜索全挂**：`web/vite.config.ts` 代理 target 忘了从 8080 改 8095（§7），或后端没启动。
- **8080 端口冲突**：后端已按 §6.3 用 `--server.port=8095` 规避；若 8095 也被占（检查 flowable-engine 是否误配），换 8096 等并同步改 vite 代理。
- **启动日志刷 `error.security.scanner.required`**：旧版本遗留，企业 fork 已修复——local profile 扫描器默认关闭、发布不再强制扫描、内置演示 skill 默认不发布；用改动后的代码重新构建（§6.2）再启动。
- **CLI 登录报 401 带 Request ID**：token 错或 scope 不够；用返回的 Request ID 对照后端日志定位。
- **`upgrade`** **提示不替换本地文件**：本地相对 `registry + namespace + slug` 的受管安装才可升级（`metadata.json` 溯源），手工乱改过的目录先 `remove` 再重装。

## 15. 与后续工作项的衔接

本手册完成的是 [设计文档](2026-09-09-skill-repo-design.md) 的**阶段一**。之后的自动化：flowable-engine 新端点 `/dsh/skills/required`（阶段二）、员工端 skill-sync 插件接管周期预装（阶段三，替代 §13 的手动 `--dir` 安装）、待办打开即时安装（阶段四）。阶段三上线后，员工 PC 不再需要安装 SkillHub CLI，§12/§13 的命令只在管理员与开发验证机上使用。
