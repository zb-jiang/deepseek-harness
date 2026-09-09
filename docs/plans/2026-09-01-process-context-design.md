# Process Context 机制设计（流程上下文变量交换）

## 3. 设计总览

三层骨架映射到 DSH 三端：

| 骨架层      | DSH 落点                                                 |
| -------- | ------------------------------------------------------ |
| 流程级上下文声明 | web-console「上下文变量」面板（process 级 `dsh:contextVariables`） |
| 节点级输出映射  | userTask 属性面板输出映射表（`dsh:outputMappings`）；引擎提交端点执行      |
| 字段级引用    | prompt 模板 `{{}}`、网关 / 表达式 `${}`（JUEL）、映射表点路径           |

输入边界不设显式映射：userTask 的 prompt 引用即输入；serviceTask 的 delegate 直读上下文（Flowable 原生）。

## 4. 流程级上下文声明

载体：process 级 `dsh:contextVariables` 扩展元素（`dsh:` 命名空间 `http://dsh.ai/bpmn`）。每个变量四要素：

- 名称：流程内唯一。
- 类型：string / integer / float / boolean / date / datetime / object / array。
- 说明：给设计者与 prompt 编辑器的展示文本。
- 初始值：可选常量。

object 类型附带字段清单（字段名 + 类型 + 说明，支持嵌套）；array 类型声明元素类型（itemType，元素为 object 时同样附带字段清单，元素为标量则无清单）。作用都是设计时提示与校验：prompt 编辑器可展开字段树，校验器可检查映射目标与表达式路径合法性。不做运行时强校验。枚举值不设独立类型，用 string 加说明标注可选值（如 approved / rejected）。

变量来源三类：

1. start-param：实例启动传入。严格声明制——启动参数必须先在声明中标记为 start-param，传入未声明变量的启动请求直接报错（fail loud）。
2. initial：声明时给定初始值，实例启动时初始化；与 start-param 可共存——启动未传入时用初始值兜底（默认值 + 可覆盖）。
3. 节点产出：userTask 由输出映射写入，校验器自动推导；其余节点（含调 DSH 的自动节点）在 delegate 代码直接 setVariable，来源由代码本身表达。

作用域：仅流程级。子流程 / 调用活动的嵌套作用域留待将来需要时再设计。

运行时存法：object 以 Map、array 以 List 存入 Flowable 流程变量（启动 JSON、AI 提交 JSON 按声明类型反序列化：integer→Long、float→Double、boolean→Boolean、object→Map、array→List）；JUEL 表达式 `${var.field.sub}`、`${invoiceList[0].amount}` 原生可用，网关条件不需要特殊解析。
date（yyyy-MM-dd）与 datetime（ISO-8601，yyyy-MM-dd'T'HH:mm:ss）以严格格式的字符串存储：入口处（启动参数、AI 提交）按格式校验，格式错报错；统一格式下字符串字典序即时间序，网关可直接写 `${endDate > '2026-12-31'}`。timer 事件如需 Date 类型，在其表达式内转换。

## 5. 节点输入边界

**userTask：prompt 引用即输入。**
所有已声明上下文变量对 prompt 编辑器可见；userPrompt 模板实际引用的变量即该节点输入。发布时校验器从模板静态提取引用，逐一检查是否在声明清单中。
对比 Lombardi 式显式输入映射（先勾选节点可见变量集，prompt 只能从勾选集里选）：Lombardi 需要预绑定是因为其活动是服务 / 代码调用，输入参数必须在执行前绑定形参；DSH 的 userTask 输入就是一段自然语言模板，模板本身即映射，再勾选一遍是重复劳动，且勾选集与实际引用易漂移。

**serviceTask：不设运行时输入机制，delegate 直读上下文。**
`execution.getVariable(...)` 直读流程上下文是 Flowable 原生能力，任意 JavaDelegate 零改造。不做引擎级输入映射（局部变量拷贝、形参改名绑定）：delegate 是黑盒代码，读了什么无从静态分析，映射拦不住也没有形参可绑；该能力（同一 delegate 跨流程复用时的形参解耦）作为进阶扩展，需要时再设计。也不设节点级消费标注（`dsh:inputVariables` 已废弃删除）：delegate 读了什么由代码本身表达，标注与代码极易漂移，漂移的标注比没有更误导。
expression 模式（`${smsSender.send(execution, phone)}`）是例外：引擎原生把流程变量绑定到方法参数，参数引用可静态提取，校验器直接解析，无需声明。

## 6. 节点输出映射

输出映射表（若干条 `来源路径 → 目标上下文变量路径`）只用于 userTask——它是唯一没有代码可写产出的节点。设计时配置的 `dsh:outputMappings` 是**默认映射模板**：用于在 userPrompt 中生成 JSON 骨架，并作为员工端提交对话框的初始映射。

实际映射执行 moved 到员工端：员工在 AI 对话中让 LLM 生成 JSON，点击"提交待办"后弹出映射确认对话框，可新增 / 修改 / 删除 source（JSON 字段路径）→ target（流程变量路径）映射；确认后员工端根据最终映射从 JSON 提取字段值，构造流程上下文变量 Map，再 POST 到引擎提交端点 `/dsh/tasks/{id}/complete`。**引擎端接收的是 variables Map，不是原始 JSON**。

多实例输出聚合：会签 / 串签下每个实例提交都上传各自的 variables Map，引擎端按 target 声明类型写入——array 类型追加（读现有 List → append → 写回），scalar / object 类型直接覆写。single（任一人提交即通过）用并行多实例 + 完成条件 `nrOfCompletedInstances >= 1`，首个提交值生效，其余任务被引擎自动删除。并发提交同一 array target 时读-改-写窗口由 Flowable 乐观锁兜底，冲突请求报错由客户端重试。

其余所有节点都在代码里写变量，不配映射：delegate 代码、脚本或 DMN 输出列直接 `setVariable` 写流程变量（Flowable 原生能力），变量名写在代码里；不设节点级产出标注（`dsh:outputVariables` 已废弃删除），代码写了什么由代码本身表达。DSH 自动节点同样如此，无特殊机制：通用的 DSH headless 调用逻辑（进程启动、超时控制、输出 JSON 解析）抽成可复用组件 `DshHeadlessClient`，每个自动节点一个定制 delegate 注入它，在自己的代码里 setVariable 写结果变量。开发阶段无存量 delegate，无兼容负担。

收益：

- 变量名由设计者语义命名（`managerApproval` 而非 `dsh_out_managerApprove`），下游网关写 `${managerApproval.decision == 'approved'}`。
- 校验器可做闭环检查：被引用的变量必有来源（start-param / initial / 输出映射或注入声明）。

### 组件适配总表

按与上下文的关系分三类，只有写数据的组件需要配置：

| 组件                                                          | 与上下文的关系              | 适配方式                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| userTask                                                    | 读 prompt 引用、写提交 JSON | prompt 引用即输入（§5）；输出映射 source=提交 JSON                                                                                                                     |
| Service Task / Send Task / Script Task / Business Rule Task | 代码或脚本读写              | 直接 setVariable 写流程变量，不配输出映射，输入直读。调 DSH 的自动节点（定制 delegate 注入 `DshHeadlessClient`）同此规则；Send Task 引擎内部同 Service Task；Script Task 在脚本里写；DMN 决策表输出列经 delegate 写回 |
| 排他 / 包容网关、连线条件、Conditional 事件                               | 纯读（JUEL 表达式）         | 不配映射；发布校验静态解析 `${}` 提取变量引用，做存在性与来源闭环检查                                                                                                                   |
| Receive Task、Message / Signal 捕获事件                          | 唤醒时注入变量              | trigger / messageEventReceived 捎带的变量直写上下文；可在属性面板做注入声明，归入节点产出来源                                                                                           |
| Message / Signal Start                                      | 带变量启动                | start-param 的另一传入通道，严格声明制同样覆盖（未声明报错）                                                                                                                     |
| 多实例                                                         | 引擎内置变量 + 输出聚合        | `nrOfInstances` / `loopCounter` 等引擎内置变量校验豁免；输出聚合见上（提交端点按 target 类型处理）                                                                                    |
| Call Activity                                               | 跨流程传递                | 用 Flowable 原生（inheritVariables + 结束回传）；子流程独立上下文声明，回传变量视作该节点产出；精细 in / out 映射随嵌套作用域将来设计                                                                   |
| Manual Task / Link / End Event / 并行网关 / 事件网关                | 无变量交互                | 无关                                                                                                                                                       |
| Timer / Escalation / Compensation / Boundary Event          | 控制流为主                | 按各自底层组件的规则（compensation handler 本身是 serviceTask）                                                                                                         |

## 7. 引用语法

| 场景                                      | 语法              | 执行者                  |
| --------------------------------------- | --------------- | -------------------- |
| prompt 模板（userTask 的 userPrompt）        | `{{var.field}}` | DSH 插值，任务创建时快照       |
| 网关条件、delegate 表达式注入                     | `${var.field}`  | Flowable 原生 JUEL     |
| 输出映射表                                   | 点路径             | 员工端提交对话框（仅 userTask） |

prompt 不用 `${}` 的原因：prompt 是自然语言模板且内嵌 JSON 格式示例，`${}` 易与示例文本、金额符号冲突，JUEL 的 Java 类型转换语义对模板不友好；`{{}}` 是设计者熟悉的模板符号。网关与 delegate 表达式是引擎地盘，`${}` 原生支持，object 变量以 Map 存储后点路径直接可用。

插值语义：任务创建时（沿用 `dsh_node_meta` 注入时机）求值快照；string 直接替换，object 序列化为 JSON 文本嵌入；变量未设置或路径中途断开（常见于分支跳过未走过的节点）替换为「空」，不保留占位符原文。会签场景每个候选人的任务各自持有创建时刻的快照，互不干扰。

输出映射路径：source 为产出 JSON 的顶层字段或点路径（空 = 整体）；target 为上下文变量名，可带 `.field` 深入路径。设计器中全部下拉点选，路径字符串只存在于 XML，设计者不必手写。

## 8. 实现落点

### BPMN XML 载体

```xml
<process id="expense" ...>
  <extensionElements>
    <dsh:contextVariables>
      <dsh:contextVariable name="expenseClaim" type="object" source="start-param"
                    description="报销申请（金额、事由、发票）"/>
      <dsh:contextVariable name="managerApproval" type="object" description="经理审批结果">
        <dsh:field name="decision" type="string" description="approved / rejected"/>
        <dsh:field name="comment" type="string" description="审批意见"/>
      </dsh:contextVariable>
      <dsh:contextVariable name="riskReport" type="object" description="风控结果">
        <dsh:field name="score" type="float" description="风险分"/>
        <dsh:field name="level" type="string" description="风险等级"/>
        <dsh:field name="checkedAt" type="datetime" description="核查时间"/>
      </dsh:contextVariable>
      <dsh:contextVariable name="invoiceList" type="array" itemType="object" description="发票清单">
        <dsh:field name="invoiceNo" type="string" description="发票号"/>
        <dsh:field name="amount" type="float" description="金额"/>
        <dsh:field name="issuedOn" type="date" description="开票日期"/>
      </dsh:contextVariable>
    </dsh:contextVariables>
  </extensionElements>

  <userTask id="managerApprove" ...>
    <extensionElements>
      <dsh:outputMappings>
        <dsh:mapping source="" target="managerApproval"/>
      </dsh:outputMappings>
    </extensionElements>
  </userTask>

  <serviceTask id="riskCheck" flowable:delegateExpression="${riskCheckDelegate}"/>
</process>
```

`riskCheckDelegate` 是定制 JavaDelegate：执行时直读 `expenseClaim`、直接 `setVariable("riskReport", value)` 写流程上下文，读写关系由代码本身表达，serviceTask 上不配任何 dsh: 标注元素。`dsh-moddle.ts`（web-console 前端）与 `DshBpmnExtensionParser`（引擎）解析 contextVariables / outputMappings；代码型节点无 dsh: 扩展元素。

### 引擎侧（apps/flowable-engine）

- `DshBpmnParseHandler`：解析 contextVariables（实例启动时初始化 initial 变量）与 userTask 的 outputMappings。
- 提交端点 `/dsh/tasks/{id}/complete`：接收员工端传来的流程上下文变量 Map，按 target 声明类型转换（integer→Long、float→Double 等），array 类型追加、其他类型覆写，再 complete 任务。
- `DshHeadlessClient`：通用 DSH headless 调用组件（进程启动、超时控制、输出 JSON 解析）；定制 delegate 需要智能服务时注入它，在自己的代码里 setVariable 写语义化结果变量（不设 `dsh_auto_output` / `dsh_auto_notes` 这类通用输出变量）。
- `DshTaskListener`：userPrompt `{{}}` 插值（任务创建时快照）。
- 启动校验：拒绝未声明的启动变量（web-console 后端为主，引擎端点兜底）。

### web-console

- 「上下文变量」面板：process 级变量清单增删改，每个变量设置：名称（流程内唯一）、类型（八种下拉）、说明、初始值（可选，按类型出对应控件）、启动传入标记（勾选即 source="start-param"，与初始值可共存）、object 字段清单 / array 元素类型（按类型条件显示）；节点产出来源不手选，从输出映射自动推导、只读展示。
- 节点属性面板：userTask 的"默认输出映射"表，source / target 下拉点选，作为员工端提交对话框的初始映射；允许为空（设计者可自行在 userPrompt 中手写 JSON）。代码型节点（Service / Send / Script / Business Rule Task）只配 Flowable 实现方式（expression / delegateExpression）与异步重试，不配变量标注。
- prompt 编辑器：变量选择器从声明清单展开字段树（object 按字段清单、array 按元素类型嵌套展开），插入 `{{}}` 占位符。
- 发布校验四查：prompt 引用存在性；条件表达式引用存在性（网关 / 连线 / Conditional 事件静态解析 `${}`，字符串字面量与方法调用名不作为变量引用）；映射 target 存在性；变量引用来源闭环（prompt、条件表达式引用的变量必有 start-param / initial / 输出映射或注入声明来源；流程含代码型节点——delegate / 脚本 / DMN / receive / callActivity——时整体豁免，代码写了什么由代码本身表达，静态无法证伪）。
- 启动实例表单：按声明的 start-param 变量生成输入项；后端拒绝未声明变量。

### 员工端 DSH

提交契约改为「员工端执行映射后提交 variables Map」：

1. 员工在 enterprise profile 的 AI 对话中处理待办，LLM 按 userPrompt 的 JSON 格式要求生成 JSON。
2. 员工点击"提交待办"，弹出映射确认对话框：JSON 只读，员工可新增 / 修改 / 删除 source（JSON 字段路径）→ target（流程变量路径）映射；默认从流程设计的 `dsh:outputMappings` 初始化，关闭对话框不保留本次编辑。
3. 员工确认后，员工端根据最终映射从 JSON 提取字段值，构造流程上下文变量 Map，POST 到 `/dsh/tasks/{id}/complete`。
4. 引擎端接收 variables Map，按声明类型转换后写入流程变量，再 complete 任务。

员工端待办处理实现为 DSH enterprise profile 插件（落点 `packages/enterprise/`），不脱离 DSH 生态，便于跟随 upstream DSH 同步。

### 迁移

未上线，直接改造存量 demo 流程与 delegate，不留兼容。

## 9. 决策记录

| # | 决策点           | 结论                                                                                                                                                             |
| - | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | 设计方向          | 三层骨架：流程级上下文声明 + 节点级映射 + 字段级引用                                                                                                                                  |
| 2 | userTask 输入边界 | prompt 引用即输入，弃 Lombardi 式显式勾选                                                                                                                                  |
| 3 | 输出映射          | 仅 userTask 配默认映射；映射执行在员工端提交对话框完成，引擎端接收 variables Map 后做类型转换与 array append；其余节点（含 DSH 自动节点）delegate 代码直接 setVariable（2026-09-02 收窄；2026-09-03 将映射执行 moved 到员工端） |
| 4 | 启动参数准入        | 严格声明制，传入未声明变量报错                                                                                                                                                |
| 5 | 引用语法          | 分层：prompt `{{}}` / 网关与表达式 `${}` / 映射表点路径                                                                                                                       |
| 6 | 文档            | 本设计文档 + CLAUDE.md 同步更新                                                                                                                                         |
| 7 | 处理策略          | Flowable 原生多实例承载 single / 会签 / 串签，废弃 taskStrategy 属性（2026-09-02，详见 CLAUDE.md 待办语义）                                                                             |
| 8 | 变量类型          | 八种：string / integer / float / boolean / date / datetime / object / array；date、datetime 以严格格式字符串存储（字典序即时间序）；枚举用 string 加说明，不设独立类型（2026-09-02）                   |
| 9 | 提交契约          | 员工端执行输出映射并提交 variables Map；引擎端废弃"接收 JSON + 按设计时映射执行"的旧契约（2026-09-03）                                                                                           |
| 10 | 消费 / 产出标注     | 删除 dsh:inputVariables / dsh:outputVariables 与对应 UI、校验逻辑：代码型节点的读写关系由代码本身表达，标注与代码易漂移（2026-09-06）                                                                              |

<br />