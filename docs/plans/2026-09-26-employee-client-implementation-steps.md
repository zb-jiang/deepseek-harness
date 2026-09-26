# 云汉员工端实施操作手册（实操版）

> 前提：仓库根目录 `D:\works\deepseek-harness`，终端用 PowerShell（5.1，不能用 `&&`）。
> 以下所有文件路径都已核实过，改动点精确到行。

---

## 任务 1：V1 验证——员工界面在桌面版里渲染正常（半天）

目标：确认 enterprise 功能装进桌面版后，待办界面显示正常。这一步通过，整装方案的地基才算成立。

### 步骤

1. **启动本机依赖服务**（两个窗口分别跑，保持不关）：
   - 流程引擎：进入 `apps/flowable-engine`，按你平时的 Spring Boot 方式启动（:8090）
   - 管理台：`pnpm run dev` 相关脚本或直接启动 web-console（:8080）

2. **确认仓库整体已构建**（enterprise-app 没有 build 脚本，它是纯 patch 层，`lib/` 产物直接随源码提交；真正要编译的是它依赖的 TS 包，走根构建）：
   ```powershell
   pnpm build
   ```
   （如果之前构建过且没改代码，可跳过。跑的时候那些 `Unsupported platform: darwin/linux` 的 WARN 是正常噪音，不用管。）

3. **以开发模式启动桌面版**：
   ```powershell
   pnpm run dev:desktop
   ```
   等待桌面版窗口弹出（数据存放在 `apps/desktop/.desktop-build/development/`，不污染真实环境）。

4. **在桌面版里安装企业插件**：
   - 打开侧栏"插件"页面
   - 选择"从本地路径安装"，路径指向 `packages/bundle/enterprise-app`
   - 如果没有本地安装入口：起一个本地商店（`npx verdaccio` → `npm adduser --registry http://localhost:4873` → `pnpm --filter "@deepseek-ai/dsh-enterprise-app..." publish --registry http://localhost:4873` → `pnpm config set registry http://localhost:4873 --global`），再从插件页搜索安装

5. **按提示重启桌面版**，检查：
   - 待办中心界面是否出现
   - 点开一条待办，人机对话办理是否正常（本机服务都在 127.0.0.1，默认配置即通）

6. **如有异常**：桌面版菜单里打开开发者工具（DevTools），把 Console 报错截图给我 —— 这就是需要适配的点。

通过标准：能登录 → 看到待办列表 → 完成一次办理。三个都 OK，V1 通过，进入任务 2。

---

## 任务 2：整装态五处改造（约 3–5 天）

全部在你自己的仓库里改，改完构建第一个"云汉员工端"安装包。

### ① 产品名与图标（半天）

文件：`apps/desktop/scripts/electron-builder-config.mjs`

- **第 109 行** `productName: 'DeepSeek Harness'` → `productName: '云汉员工端'`
- **第 110 行** `artifactName` 里的 `deepseek-harness-` 前缀 → `yunhan-employee-`
- 同文件 **第 78 行附近** `protocols` 里 `name: 'DeepSeek Harness'` → `name: 'Yunhan Employee'`

图标（直接替换同名文件即可，不用改代码）：
- `apps/desktop/resources/icon-windows.png` —— 换成云汉图标（512×512 PNG）
- `apps/desktop/resources/tray-windows.ico` —— 托盘图标（ICO 格式，含 16/32/48 多尺寸）

应用 ID：构建时是环境变量 `DSH_DESKTOP_APP_ID`，固定写成：
```powershell
$env:DSH_DESKTOP_APP_ID = "com.yunhan.employee"
```

### ② 打包清单加入企业功能（1–2 天）

文件：`apps/desktop/src/core-package-set.ts`

- 第 34 行附近 `const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE]` 里追加企业包：
  ```ts
  const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE, '@deepseek-ai/dsh-enterprise-app'] as const
  ```
- 打包脚本会自动沿着依赖树把这串内部包全部收进来，不用手工列。
- 改完先跑 `pnpm run check:package` 验证清单合法性。

### ③ 出厂预装企业 profile（1–2 天）

桌面版 profile 固定在 `~/.dsh/profiles/desktop`（定义在 `apps/desktop/src/paths.ts` 第 19 行）。

做法：
1. 在你本机手工搭出一个"理想 profile"：装好 enterprise-app 后，把 `~/.dsh/profiles/desktop` 整个目录复制一份作为模板，存到 `apps/desktop/resources/profile-template/`
2. 在桌面版主进程里加"首启逻辑"：**如果 `profiles/desktop` 不存在，就把模板复制过去**（已存在则不动）。这段逻辑的落点在 Electron 主进程启动代码里（`apps/desktop/lib/` 对应源码 `src/`）——做到这一步时告诉我，我帮你定位确切的插入点

### ④ 服务器地址写死（半天）

文件：`packages/bundle/enterprise-app/cordis.patch.yml`

把所有 `!!js process.env.XXX ?? '默认值'` 改成公司实际地址字面量，例如：
```yaml
supabaseUrl: 'https://xxxx.supabase.co'
webConsoleBaseUrl: 'http://console.yunhan.internal:8080'
engineBaseUrl: 'http://engine.yunhan.internal:8090'
skillhubBaseUrl: 'http://skillhub.yunhan.internal:8095'
```
改完后员工端不再需要任何环境变量。**注意：`skillhubToken` 一栏先留空**——全局 token 不能下发到员工机（P2 改造项）。

### ⑤ 更新源指向内网（半天）

文件：`apps/desktop/scripts/electron-builder-config.mjs`

- **第 247 行** `publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, ... }]`
  → 改成 `publish: [{ provider: 'generic', url: 'http://你的内网服务器/updates/win-x64/' }]`
- **第 213 行附近** `const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(...)`——未签名构建默认**不带**自动更新。试点期用未签名包时要自动更新的话，把这一行的 `unsigned ? undefined :` 短路掉（正式推广买签名证书后可还原）。

### 构建第一个安装包

```powershell
$env:DSH_DESKTOP_APP_ID = "com.yunhan.employee"
pnpm run package:desktop:win:x64:unsigned
```

产物位置：`apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` 下的 exe。
自己机器上双击安装走一遍完整流程验证。

---

## 任务 3：更新服务器（1 天，可与任务 2 并行）

### 搭建

1. 找一台员工都能访问的内网机器（或先用自己的电脑）
2. 建目录，例如 `D:\yunhan-updates\win-x64\`
3. 用任意静态文件服务对外提供该目录，三选一：
   - IIS（Windows 自带，图形界面配置）
   - `npx serve D:\yunhan-updates`（最快）
   - nginx（正式推荐）

### 发版

每次发新版，往目录里放两个文件（构建产物里都有）：
- `yunhan-employee-x.x.x.exe`（安装包）
- `latest.yml`（electron-builder 自动生成的版本清单，**员工端靠它判断有没有新版，必须一起更新**）

### 验证更新链路

仓库自带本地更新测试脚本：
```powershell
pnpm --filter @deepseek-ai/dsh-desktop run test:updates:local
```

### 日常升级流程（以后每次发版）

1. 收到官方 Release 通知 → 同步 tag → 合并 → 跑全量测试
2. `pnpm run package:desktop:win:x64:unsigned` 构建新包
3. 把新 exe + latest.yml 覆盖到更新服务器目录
4. 员工端下次启动自动提示"发现新版本"，点一下就完成升级

---

## 顺序提醒

**任务 1 必须最先做**——如果 V1 失败，任务 2 的方案要调整，先验证再投入。
