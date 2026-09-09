# ModLens 视觉插件安装与配置指南（员工端发票识图）

> 目的：给员工端 DSH 的纯文本模型（DeepSeek）补上图片识别能力，支撑差旅报销 DEMO 第一个待办「员工提交报销单」的发票图片逐张提取（[2026-09-05-e2e-demo-design.md](2026-09-05-e2e-demo-design.md) §6.1 skill `expense-form-assistant`）。
> 适用环境：Windows 11 + PowerShell；DSH enterprise profile（员工端，DEMO 终端 C）。
> 上游项目：<https://github.com/liustack/modlens> （MIT 许可，第三方插件，非 DSH 官方组件）。

## 1. 为什么需要 ModLens

DEMO 整条流程只有一处需要 AI 看图——张三提交环节；其余环节消费的是提交时已生成的 `invoiceList` JSON：

| 环节               | 是否识图 | 依据                                     |
| ---------------- | ---- | -------------------------------------- |
| 员工提交报销单（张三）      | 需要   | skill 要求多张发票图片逐张提取发票号 / 金额 / 开票日期 / 类型 |
| 主管 / 经理 / 费用专员审批 | 不需要  | 只读 prompt 插值快照与审批 JSON                 |
| 财务票据审核（钱财务）      | 不需要  | 对账已提取的 `invoiceList`，不重新 OCR           |
| 出纳打款确认           | 不需要  | 只确认 transactionId                      |

员工端配的是 `DEEPSEEK_API_KEY`，DeepSeek 对话模型是纯文本模型读不了图。ModLens 的作用：图片粘贴进对话后由插件转发给一个外部视觉引擎，转成结构化转写文本（全文转写 / 版面区域 / 实体清单）再交给文本模型。因此只需装在**提交人（张三）登录的机器**上；DEMO 单机多账号跑法下即本机，其余 7 个角色账号无需任何配置。

不装也能跑通流程：skill 支持纯文字路径（如「出差北京 3 晚住宿 688+890+802」），DMN、会签、验票全链路照常（demo 设计 §7 阶段五）。ModLens 只影响「上传发票图片」这条体验路径。

## 2. 前置条件

- DSH enterprise profile 已可运行（demo 设计 §1.3 终端 C：3 个环境变量 + `pnpm dsh --profile enterprise`）。
- Node >= 22.19（ModLens 引擎要求；仓库本身的要求已覆盖，天然满足）。
- 一个视觉引擎凭据（§4 二选一：免费 Gemini key，或任意 OpenAI 兼容多模态端点的 key）。

## 3. 安装插件（enterprise profile）

在仓库根目录执行（员工端从源码跑的对应命令）：

```powershell
cd d:\works\deepseek-harness
pnpm dsh plugin --profile enterprise add @liustack/modlens@latest
```

enterprise profile 是随附模板（base + web-app + enterprise-app），安装在 `~/.dsh/profiles/enterprise`，modlens 作为额外插件层追加，不影响既有组成。安装后**重启员工端**（终端 C 的 DSH 进程）生效。

## 4. 配置视觉引擎（装完插件后必须，二选一）

视觉引擎不是另装的软件，而是给 ModLens 配一个视觉提供方；配置存于 `~/.modlens/config.json`，全部经 `modlens` 命令完成。该命令不在 PATH 上，每个新终端先设别名：

```powershell
$ml = "$env:USERPROFILE\.dsh\profiles\enterprise\node_modules\.bin\modlens.cmd"
```

以下命令均以 `& $ml <子命令>` 形式执行。

### 4.1 方案 A：免费 Gemini key（官方推荐，读一次 5-10 秒）

1. 浏览器打开 <https://aistudio.google.com> 创建 API key（约 3 分钟，免信用卡；免费档约 10-15 次/分钟、1500 次/天，不过期）。
2. 存入配置（省略值会出隐藏输入提示，key 不进命令历史与终端回显）：

```powershell
& $ml config set gemini-api.apiKey sk-你的key
```

1. 国内访问 Google 需代理，按实际端口配置全局代理：

```powershell
& $ml config set proxy http://127.0.0.1:7890
```

默认模型 `gemini-3.6-flash`（免费档含视觉），无需再指定。

### 4.2 方案 B：OpenAI 兼容端点（无需代理，适合国内网络）

以阿里云百炼 qwen-vl 为例（<https://bailian.console.aliyun.com> 开通取 sk- key）：

```powershell
& $ml config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
& $ml config set openai.apiKey sk-你的key
& $ml config set openai.model qwen3-vl-plus
```

注意：

- `openai` 路由**必须显式指定 model**（无默认值），且模型必须支持图片输入；纯文本模型会失败或产生幻觉。
- 若运行时报「模型只答了一半契约」类错误，追加 `& $ml config set openai.structuredOutput true` 强制端点按 JSON schema 输出；若端点不认该字段返回 400，再关掉（`false`）。
- 同样的三行命令可指向任何 OpenAI 兼容视觉端点（SiliconFlow、OpenRouter、自托管 vLLM/Ollama 网关等）。

### 4.3 其他引擎（了解即可）

`anthropic`（Anthropic key）、`claude-cli` / `kimi-cli`（复用本机已登录的对应订阅，零新 key）、`antigravity-cli`（免费兜底，需另装 Google agy CLI 并浏览器登录，其安装脚本是 bash，Windows 下不作首选）。不设 provider 时所有已配置引擎自动组成故障转移链（API 引擎优先、CLI 垫后），单次读图失败自动换下一个，`meta.attempts` 记录每次尝试；想固定单个引擎：`& $ml config set provider gemini-api`。

## 5. 验证

```powershell
& $ml doctor            # 体检：各引擎就绪状态、故障转移链、守卫规则；不消耗额度
& $ml -i C:\path\to\发票.png   # 真读一张图，输出 JSON（ocr.full_text / layout.regions / semantics）
```

`doctor` 中所配引擎显示 ready 即配置成功。

## 6. 在 DEMO 中的使用

配置完成后**无需任何手动步骤**：张三在员工端 DSH 对话框（「员工提交报销单」待办打开的 AI 窗口）里直接粘贴 / 拖入发票图片，skill 自动触发，图片经视觉引擎转写后交给 DeepSeek 模型逐张提取。两种粘贴形态：

- 直接粘贴：图片落为私有临时文件，路径进入输入框，由 `modlens_read_image` 工具接管（用户无感）。
- 在模型选择器选带 `(modlens vision)` 后缀的条目（如 `DeepSeek-V4-Flash (modlens vision)`）：缩略图保留在消息里，请求时转换为结构化转写，同一条底层路由。

员工端 Web 界面的「设置 → 插件 → 插件配置」里有 ModLens 卡片，可在界面上切换引擎 / 配代理，与 CLI 写的是同一份配置。

## 7. 常用运维

| 操作          | 命令                                                              |
| ----------- | --------------------------------------------------------------- |
| 查看脱敏配置      | `& $ml config show`                                             |
| 固定 / 取消固定引擎 | `& $ml config set provider <name>`（置空走故障转移链）                    |
| 清空配额冷却状态    | `& $ml state clear`（额度耗尽的引擎被降级冷却，清除后恢复满优先级）                     |
| 卸载插件        | `pnpm dsh plugin --profile enterprise remove @liustack/modlens` |

配置文件本体：`C:\Users\<用户名>\.modlens\config.json`（权限 0600，可手改，改完跑一次 `doctor` 核对生效值）。

## 8. 合规备注（生产环境）

- 发票图片会**外发到所配置的第三方视觉 API**：方案 A 免费档 Gemini 的数据可能被 Google 用于产品改进，敏感票据慎用；方案 B 发往阿里云。
- 生产环境不想让票据出公网时，把 `openai.baseUrl` 指向**内网自托管视觉网关**（vLLM / Ollama 部署 qwen-vl 等），命令与方案 B 完全一致，仅地址换内网。
- 上游安全说明（远程 URL 抓取范围、图片内容按不可信输入处理）：<https://github.com/liustack/modlens/blob/main/docs/security.md>

## 9. 参考

- 安装向导（写给 AI 执行）：<https://github.com/liustack/modlens/blob/main/INSTALL.md>
- 配置详解（provider 字段、守卫、复用登录）：<https://github.com/liustack/modlens/blob/main/skills/modlens/references/configure.md>
- CLI 手册（flags、doctor、config）：<https://github.com/liustack/modlens/blob/main/docs/cli.md>
- 故障排查：<https://github.com/liustack/modlens/blob/main/docs/troubleshooting.md>
- 输出契约（JSON 结构）：<https://github.com/liustack/modlens/blob/main/docs/output-schema.md>