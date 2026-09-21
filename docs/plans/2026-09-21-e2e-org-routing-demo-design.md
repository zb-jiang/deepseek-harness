# 端到端 DEMO v2：组织维度审批路由 + BPMN 组件全覆盖

## 0. 总览：八场景与组件分别在哪验证

### 0.1 八场景 → 测试点映射

| 场景 | 验证载体 | 关键断言 |
| --- | --- | --- |
| 8.1 A/B 部门隔离 | P1「专线审批」节点（sameLine + 实体角色） | A 部门员工发起 → 仅 A 线该角色成员收待办，B 部门人不可见；反向亦然 |
| 8.2 上一级链 | P1「直属审批」节点（虚拟 parent） | 小王发起→张三；张三发起→老周；老周发起→马总；马总发起→到顶自动通过（审计留痕，流程继续） |
| 8.3 发文会签 | P2「下级负责人会签」节点（虚拟 child 扇出）×3 个流程定义 | single 任一人提交即收 / countersign 全员 / sequential 逐个；扇出对象=下级所有部门负责人 |
| 8.4 指定部门 | P1「财务复核」节点（fixedUnit=财务部） | 仅财务部子树内该角色成员收待办 |
| 8.5 多身份发起 | P1 发起环节（web-console 身份下拉 + 员工端 AI 发起） | 兼两部门员工不选身份报错；以 A 身份走 A 线；以 B 身份走 B 线；API 伪造 orgUnitId 被拒 |
| 8.6 跨部门成员判定 | 与 8.1 同一节点，观察小陈 | 小陈兼 A/B 两部门，两条线的 sameLine 待办都能派到 |
| 8.7 存量流程回归 | v1 差旅报销流程原样重跑 | 无 orgScope 的已发布流程行为与升级前完全一致 |
| 8.8 超时升级 | P1「直属审批」/「出纳打款」的 timeoutPolicy | 直属审批超时→升级到父部门负责人（锚定当前审批人）；global 待办升级且审批人多部门→报错不静默 |

### 0.2 组件 → 节点映射

| 组件（教程节号） | 落点 |
| --- | --- |
| UserTask 多实例·单人（§12） | P1 全部 5 个 userTask（并行多实例 + `${nrOfCompletedInstances >= 1}`） |
| UserTask 多实例·会签/串签（§12） | P2 会签节点三个流程定义分别演示 countersign（并行留空）/ sequential（串行） |
| 会签计票 votingRule（§12） | P2「多 AI 合规评审」（backend task + votingRule 2 profile 1 票通过即收） |
| ServiceTask 多实例·集合形式（§11） | P1「逐张发票复核」（collection=invoiceList，elementVariable=invoice） |
| DSH backend task 单实例（§2） | P2「AI 润色正文」 |
| DSH backend task 多实例（§13） | P2「多 AI 合规评审」（profile 列表 2 行 + votingRule） |
| Service Task 定制 delegate + async + 重试 | P1/P2 全部通知节点（`flowable:async="true"` + `failedJobRetryTimeCycle`） |
| Script Task（juel，§5） | P1「生成报销摘要」 |
| DMN 决策表（§6，经 ServiceTask 表达式） | P1「决定审批专线」 |
| 排他网关（§7） | P1 ×4、P2 ×1 |
| 并行网关（§9） | P1 收尾「归档 ∥ 通知」分支、P2 收尾同构 |
| Timer 边界事件·非中断（§25.1） | P1「财务复核」挂 PT2M 催办（任务保留） |
| timeoutPolicy 超时升级（`dsh:actionPolicy`，非图形组件） | P1「直属审批」「出纳打款」（`escalateToVirtualRole="parent"`） |
| 排他/并行网关以外的网关、消息/信号等事件类 | 非主流必需，本 DEMO 不覆盖（教程已讲解，可自行加练） |

### 0.3 端口与服务

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| Flowable 引擎 | 8090 | REST + 自定义端点 |
| Web Console 后端 | 8080 | 治理 API + 发起 API |
| Web Console 前端 | 5173 | Vite dev |
| DSH 员工端 | 默认 | enterprise profile |
| DSH backend profile | 默认 | enterprise-backend profile（P2 需要） |

***

## 1. 场景与布景设计

### 1.1 组织树（org_units）

```
总公司(负责人:马总)
├── 华东区(负责人:老周)
│   ├── A 部门(负责人:张三)
│   └── B 部门(负责人:李四)
└── 财务部(负责人:钱姐)
```

### 1.2 用户与归属（8 个 Supabase Auth 账号）

| 账号 | 部门归属（org_unit_members） | 角色成员（应用内角色） | 用途 |
| --- | --- | --- | --- |
| 马总 | 总公司 | 报销人 | 8.2 到顶、8.3 发文发起 |
| 老周 | 华东区 | 报销人、审批专员 | 8.2 第三级、8.1 "从下往上找第一个"反证 |
| 张三 | A 部门 | 报销人 | 8.2 第二级、8.8a 超时升级对象 |
| 李四 | B 部门 | 报销人 | 8.1 B 线发起、8.1 反断言对象 |
| 小王 | A 部门 | 报销人 | 8.1/8.2/8.6 主发起人 |
| **小陈** | **A 部门 + B 部门（多对多核心）** | 报销人、审批专员、出纳 | 8.5 多身份、8.6 跨部门、8.8b 报错测试 |
| 钱姐 | 财务部 | 财务复核员 | 8.4 指定部门 |
| 小钱 | 财务部 | 财务复核员 | 8.4 子树内多成员 |

> 设计意图：
> - **审批专员角色跨两级**（小陈在 A/B 部门、老周在华东区）——8.1 同时验证"从申请人部门**从下往上找第一个**该职位"：小王（A 部门）发起解析到小陈（A 部门内）而不是老周（华东区）。
> - **小陈兼 A/B 两部门**——8.5/8.6 的全部戏剧性都在他身上；同时把他放进**出纳**角色（global 待办），8.8b 才能触发"升级锚点回退映射表 → 多部门 → 报错"。
> - 负责人指定后引擎会自动把负责人 upsert 进 `org_unit_members`（阶段 4.2 实现），无需手工补。

### 1.3 流程族

| 流程 | process id | 用途 |
| --- | --- | --- |
| P1 费用报销（组织路由版） | `expenseOrgRouting` | 8.1/8.2/8.4/8.5/8.6/8.8 + 大部分组件 |
| P2 发文审批（三策略） | `documentReviewSingle` / `documentReviewCountersign` / `documentReviewSequential` | 8.3 + backend task / 多 AI 计票 / child 扇出 |
| v1 差旅报销 | `expenseReimbursement`（v1 文档） | 8.7 存量回归，原样重跑 |

P1 业务流：员工提交报销单（发票 AI 提取）→ 生成摘要（Script Task）→ DMN 决定是否需专线审批 → 逐张发票复核（ServiceTask 多实例）→ 直属审批（虚拟 parent，挂超时升级）→（大额）专线审批（sameLine 实体角色）→ 财务复核（指定部门，挂非中断催办 Timer）→ 出纳打款（全公司，挂超时升级用于报错测试）→ 归档 ∥ 通知（并行网关）。任一审批/验票拒绝 → 汇聚通知 → 结束。

P2 业务流：发起时传入 title/content（start-param）→ AI 润色正文（backend task）→ 多 AI 合规评审（backend task 多实例 + votingRule）→ 下级负责人会签（虚拟 child，三个定义分别为 single/countersign/sequential）→ 归档 ∥ 通知（并行网关）。

### 1.4 UUID 占位符（9 个 + profile 地址）

复制 XML 前全局替换：

| 占位符 | 替换为 |
| --- | --- |
| `ORG_HEAD_UUID` | 总公司部门 id |
| `ORG_EAST_UUID` | 华东区部门 id |
| `ORG_A_UUID` | A 部门部门 id |
| `ORG_B_UUID` | B 部门部门 id |
| `ORG_FINANCE_UUID` | 财务部部门 id |
| `ROLE_SUBMITTER_UUID` | 报销人角色 id |
| `ROLE_SPECIAL_UUID` | 审批专员角色 id |
| `ROLE_FINANCE_UUID` | 财务复核员角色 id |
| `ROLE_CASHIER_UUID` | 出纳角色 id |
| `PROFILE_URL_N` | backend profile 实例地址（P2，如 `http://127.0.0.1:3081`） |

> 部门 id 在组织管理页详情（或 Supabase `org_units` 表）取；角色 id 在应用详情 → 角色 → 复制 ID。
> XML 中的 `<bpmndi:BPMNDiagram>` 段是画布坐标，**必须保留**。

***

## 2. 启动准备

与 v1 §1 完全一致的三个 `.env` / 启动方式（终端 A 引擎、终端 B 后端+前端、终端 C 员工端），此处不再重复——**先按 v1 §1.0–1.3 把三个服务跑起来**。以下只列 v2 新增项。

### 2.1 终端 D：DSH backend profile（P2 需要，跑 P1 可跳过）

```powershell
cd d:\works\deepseek-harness
pnpm run build                # 仓库改动后需要
$env:DEEPSEEK_API_KEY="<你的 LLM key>"
$env:WEB_CONSOLE_URL="http://127.0.0.1:8080"   # 启动即向 web-console 注册(heartbeat 维持存活)
pnpm dsh --profile enterprise-backend
# 启动后 Web Console → backend profiles 注册表应出现本实例且为 active
```

> backend profile 的工作空间/LLM 配置独立；多实例并存时可再起一个（不同端口），P2 的 profile 列表就能填不同 URL。单实例也够用：**profile 列表两行填同一 URL 是合法的**（教程 §13 明确"想多个实例绑同一个 profile 就重复选同一行"）。
> backend profile 周期同步名下 backend task 引用的 skillRefs；本 DEMO 的 backend task 不配 skillRefs（prompt 自足），无需准备 skill。

### 2.2 员工端 AI 发起（终端 C 增量）

阶段 7 的 process-start 插件已注册进 enterprise profile，终端 C 按 v1 §1.3 启动后即自带三个工具（`dsh_process_list` / `dsh_process_start_form` / `dsh_process_start`）。员工端对 web-console 的访问经本地 webserver 代理，无需额外环境变量。

***

## 3. 文件清单 & 复制位置

| # | 文件 | 复制到 | 后续动作 |
| --- | --- | --- | --- |
| 1 | DMN XML（§6） | `apps/flowable-engine/src/main/resources/dmn/orgRoutingLevel.dmn` | 重启引擎生效（v1 的 `approvalLevel.dmn` 可共存，decision id 不同） |
| 2 | 2 个 JavaDelegate（§7） | `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/` | `mvn compile` + 重启引擎 |
| 3 | P1 BPMN XML（§4） | Web Console 画布 XML 视图粘贴 | 无 |
| 4 | P2 BPMN XML ×3（§5） | 同上（三个流程定义，只差会签节点一处配置） | 无 |
| 5 | SKILL.md ×2（§8） | `%USERPROFILE%\.dsh\skills\<skill名>\SKILL.md` | DSH 自动扫描，无需重启 |

***

## 4. P1 BPMN XML：费用报销（组织路由版）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:flowable="http://flowable.org/bpmn" xmlns:dsh="http://dsh.ai/bpmn" id="ExpenseOrgRouting" targetNamespace="http://dsh.ai/expense2">
  <bpmn2:process id="expenseOrgRouting" name="费用报销(组织路由版)" isExecutable="true">
    <bpmn2:extensionElements>
      <dsh:contextVariables>
        <dsh:contextVariable name="initiator" type="object" description="流程发起人(启动时按登录人自动注入,不允许提交)" source="system">
          <dsh:field name="userId" type="string" description="Supabase Auth user.id" />
          <dsh:field name="name" type="string" description="显示名" />
          <dsh:field name="email" type="string" description="邮箱" />
        </dsh:contextVariable>
        <dsh:contextVariable name="amount" type="float" description="报销金额(发票合计)" />
        <dsh:contextVariable name="reason" type="string" description="报销事由" />
        <dsh:contextVariable name="invoiceList" type="array" description="发票清单" itemType="object">
          <dsh:field name="invoiceNo" type="string" description="发票号" />
          <dsh:field name="amount" type="float" description="单张金额" />
          <dsh:field name="issuedOn" type="date" description="开票日期" />
          <dsh:field name="expenseType" type="string" description="类型" />
        </dsh:contextVariable>
        <dsh:contextVariable name="summary" type="string" description="报销摘要(Script Task 生成)" />
        <dsh:contextVariable name="level" type="string" description="审批专线(DMN 产出)" />
        <dsh:contextVariable name="approvalResult" type="string" description="审批结论(approve/reject)" />
        <dsh:contextVariable name="approvalComment" type="string" description="审批意见" />
        <dsh:contextVariable name="financeVerified" type="boolean" description="验票是否通过" />
        <dsh:contextVariable name="financeNotes" type="string" description="验票说明" />
        <dsh:contextVariable name="paymentConfirmed" type="boolean" description="打款是否完成" />
        <dsh:contextVariable name="transactionId" type="string" description="打款流水号" />
      </dsh:contextVariables>
    </bpmn2:extensionElements>
    <bpmn2:startEvent id="startEvent" name="开始" />
    <bpmn2:sequenceFlow id="flow01" sourceRef="startEvent" targetRef="submitExpense" />
    <bpmn2:userTask id="submitExpense" name="员工提交报销单">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_SUBMITTER_UUID" />
        <dsh:skillRef>expense-form-assistant</dsh:skillRef>
        <dsh:userPrompt text="请说明报销事由并上传本次全部发票（可多张）。调用 expense-form-assistant skill 逐张提取发票信息（发票号、金额、开票日期、类型）、做要素审核并计算合计金额，最后输出纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="amount" target="amount" />
          <dsh:mapping source="reason" target="reason" />
          <dsh:mapping source="invoiceList" target="invoiceList" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow02" sourceRef="submitExpense" targetRef="buildSummary" />
    <bpmn2:scriptTask id="buildSummary" name="生成报销摘要" scriptFormat="juel">
      <bpmn2:script>execution.setVariable('summary', '报销事由：' + reason + '；合计 ' + amount + ' 元，共 ' + invoiceList.size() + ' 张发票')</bpmn2:script>
    </bpmn2:scriptTask>
    <bpmn2:sequenceFlow id="flow03" sourceRef="buildSummary" targetRef="decideLevel" />
    <bpmn2:serviceTask id="decideLevel" name="DMN:决定审批专线" flowable:expression="${execution.setVariables(dmnRuleService.createExecuteDecisionBuilder().decisionKey(&#39;orgRoutingLevel&#39;).variables(execution.getVariables()).executeWithSingleResult())}" />
    <bpmn2:sequenceFlow id="flow04" sourceRef="decideLevel" targetRef="auditInvoices" />
    <bpmn2:serviceTask id="auditInvoices" name="逐张发票复核" flowable:delegateExpression="${invoiceAuditDelegate}">
      <bpmn2:multiInstanceLoopCharacteristics isSequential="false" flowable:collection="invoiceList" flowable:elementVariable="invoice" />
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow05" sourceRef="auditInvoices" targetRef="directManagerApprove" />
    <bpmn2:userTask id="directManagerApprove" name="直属审批">
      <bpmn2:extensionElements>
        <dsh:assignmentRule virtualRole="parent" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 universal-approver skill 审批 {{initiator.name}} 的差旅报销：{{summary}}，发票清单 {{invoiceList}}。核对合理性，输出包含 approvalResult（approve/reject）与 approvalComment 的纯JSON。" />
        <dsh:actionPolicy>
          <dsh:timeoutPolicy duration="PT2M" escalateToVirtualRole="parent" />
        </dsh:actionPolicy>
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow06" sourceRef="directManagerApprove" targetRef="gatewayMgrOutcome" />
    <bpmn2:exclusiveGateway id="gatewayMgrOutcome" name="直属通过?" />
    <bpmn2:sequenceFlow id="flow07" sourceRef="gatewayMgrOutcome" targetRef="gatewayNeedSpecial">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow08" sourceRef="gatewayMgrOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:exclusiveGateway id="gatewayNeedSpecial" name="还要专线?" />
    <bpmn2:sequenceFlow id="flow09" sourceRef="gatewayNeedSpecial" targetRef="specialLineApprove">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${level.contains('专线')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow10" sourceRef="gatewayNeedSpecial" targetRef="financeVerify">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!level.contains('专线')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="specialLineApprove" name="专线合规审批">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_SPECIAL_UUID" orgScope="sameLine" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 universal-approver skill 进行专线合规审批：{{summary}}。核对合规性，输出包含 approvalResult（approve/reject）与 approvalComment 的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow11" sourceRef="specialLineApprove" targetRef="gatewaySpecialOutcome" />
    <bpmn2:exclusiveGateway id="gatewaySpecialOutcome" name="专线通过?" />
    <bpmn2:sequenceFlow id="flow12" sourceRef="gatewaySpecialOutcome" targetRef="financeVerify">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow13" sourceRef="gatewaySpecialOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="financeVerify" name="财务复核">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_FINANCE_UUID" orgScope="fixedUnit" fixedUnitId="ORG_FINANCE_UUID" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 universal-approver skill 验票：发票清单 {{invoiceList}}，合计 {{amount}} 元。核对要素与勾稽，输出包含 financeVerified（true/false）与 financeNotes 的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="financeVerified" target="financeVerified" />
          <dsh:mapping source="financeNotes" target="financeNotes" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:boundaryEvent id="boundaryUrgeFinance" name="2分钟未复核催办" cancelActivity="false" attachedToRef="financeVerify">
      <bpmn2:timerEventDefinition id="timerUrgeFinance">
        <bpmn2:timeDuration xsi:type="bpmn2:tFormalExpression">PT2M</bpmn2:timeDuration>
      </bpmn2:timerEventDefinition>
    </bpmn2:boundaryEvent>
    <bpmn2:sequenceFlow id="flow14" sourceRef="financeVerify" targetRef="gatewayFinOutcome" />
    <bpmn2:exclusiveGateway id="gatewayFinOutcome" name="验票通过?" />
    <bpmn2:sequenceFlow id="flow15" sourceRef="gatewayFinOutcome" targetRef="cashierConfirm">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow16" sourceRef="gatewayFinOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:serviceTask id="urgeFinance" name="自动催办复核" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow17" sourceRef="boundaryUrgeFinance" targetRef="urgeFinance" />
    <bpmn2:endEvent id="endUrged" name="已催办" />
    <bpmn2:sequenceFlow id="flow18" sourceRef="urgeFinance" targetRef="endUrged" />
    <bpmn2:userTask id="cashierConfirm" name="出纳打款确认">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_CASHIER_UUID" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 universal-approver skill 执行打款：收款人 {{initiator.name}}，金额 {{amount}} 元。输出包含 paymentConfirmed（true）与 transactionId 的纯JSON。" />
        <dsh:actionPolicy>
          <dsh:timeoutPolicy duration="PT2M" escalateToVirtualRole="parent" />
        </dsh:actionPolicy>
        <dsh:outputMappings>
          <dsh:mapping source="paymentConfirmed" target="paymentConfirmed" />
          <dsh:mapping source="transactionId" target="transactionId" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow19" sourceRef="cashierConfirm" targetRef="notifyPayment" />
    <bpmn2:serviceTask id="notifyPayment" name="通知打款结果" flowable:async="true" flowable:delegateExpression="${logDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow20" sourceRef="notifyPayment" targetRef="gatewaySplit" />
    <bpmn2:parallelGateway id="gatewaySplit" name="分流" />
    <bpmn2:sequenceFlow id="flow21" sourceRef="gatewaySplit" targetRef="archive" />
    <bpmn2:serviceTask id="archive" name="归档" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow22" sourceRef="gatewaySplit" targetRef="notifyDone" />
    <bpmn2:serviceTask id="notifyDone" name="通知发起人" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow23" sourceRef="archive" targetRef="gatewayJoin" />
    <bpmn2:sequenceFlow id="flow24" sourceRef="notifyDone" targetRef="gatewayJoin" />
    <bpmn2:parallelGateway id="gatewayJoin" name="汇聚" />
    <bpmn2:sequenceFlow id="flow25" sourceRef="gatewayJoin" targetRef="endEvent" />
    <bpmn2:endEvent id="endEvent" name="结束" />
    <bpmn2:exclusiveGateway id="gatewayRejected" name="存在拒绝" />
    <bpmn2:sequenceFlow id="flow26" sourceRef="gatewayRejected" targetRef="notifyRejected" />
    <bpmn2:serviceTask id="notifyRejected" name="通知报销被拒" flowable:async="true" flowable:delegateExpression="${logDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow27" sourceRef="notifyRejected" targetRef="endRejected" />
    <bpmn2:endEvent id="endRejected" name="报销被拒" />
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="expenseOrgRouting">
      <bpmndi:BPMNShape id="startEvent_di" bpmnElement="startEvent"><dc:Bounds x="150" y="238" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="submitExpense_di" bpmnElement="submitExpense"><dc:Bounds x="250" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="buildSummary_di" bpmnElement="buildSummary"><dc:Bounds x="420" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="decideLevel_di" bpmnElement="decideLevel"><dc:Bounds x="590" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="auditInvoices_di" bpmnElement="auditInvoices"><dc:Bounds x="760" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="directManagerApprove_di" bpmnElement="directManagerApprove"><dc:Bounds x="930" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayMgrOutcome_di" bpmnElement="gatewayMgrOutcome" isMarkerVisible="true"><dc:Bounds x="1085" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayNeedSpecial_di" bpmnElement="gatewayNeedSpecial" isMarkerVisible="true"><dc:Bounds x="1175" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="specialLineApprove_di" bpmnElement="specialLineApprove"><dc:Bounds x="1270" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewaySpecialOutcome_di" bpmnElement="gatewaySpecialOutcome" isMarkerVisible="true"><dc:Bounds x="1415" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="financeVerify_di" bpmnElement="financeVerify"><dc:Bounds x="1510" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="boundaryUrgeFinance_di" bpmnElement="boundaryUrgeFinance"><dc:Bounds x="1542" y="272" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="urgeFinance_di" bpmnElement="urgeFinance"><dc:Bounds x="1470" y="380" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endUrged_di" bpmnElement="endUrged"><dc:Bounds x="1630" y="402" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayFinOutcome_di" bpmnElement="gatewayFinOutcome" isMarkerVisible="true"><dc:Bounds x="1660" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="cashierConfirm_di" bpmnElement="cashierConfirm"><dc:Bounds x="1755" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyPayment_di" bpmnElement="notifyPayment"><dc:Bounds x="1905" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewaySplit_di" bpmnElement="gatewaySplit" isMarkerVisible="true"><dc:Bounds x="2055" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="archive_di" bpmnElement="archive"><dc:Bounds x="2155" y="120" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyDone_di" bpmnElement="notifyDone"><dc:Bounds x="2155" y="310" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayJoin_di" bpmnElement="gatewayJoin" isMarkerVisible="true"><dc:Bounds x="2305" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEvent_di" bpmnElement="endEvent"><dc:Bounds x="2400" y="238" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayRejected_di" bpmnElement="gatewayRejected" isMarkerVisible="true"><dc:Bounds x="1275" y="530" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyRejected_di" bpmnElement="notifyRejected"><dc:Bounds x="1400" y="515" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endRejected_di" bpmnElement="endRejected"><dc:Bounds x="1560" y="537" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow01_di" bpmnElement="flow01"><di:waypoint x="186" y="256" /><di:waypoint x="250" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow02_di" bpmnElement="flow02"><di:waypoint x="350" y="256" /><di:waypoint x="420" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow03_di" bpmnElement="flow03"><di:waypoint x="520" y="256" /><di:waypoint x="590" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow04_di" bpmnElement="flow04"><di:waypoint x="690" y="256" /><di:waypoint x="760" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow05_di" bpmnElement="flow05"><di:waypoint x="860" y="256" /><di:waypoint x="930" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow06_di" bpmnElement="flow06"><di:waypoint x="1030" y="256" /><di:waypoint x="1085" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow07_di" bpmnElement="flow07"><di:waypoint x="1135" y="256" /><di:waypoint x="1175" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow08_di" bpmnElement="flow08"><di:waypoint x="1110" y="281" /><di:waypoint x="1110" y="555" /><di:waypoint x="1275" y="555" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow09_di" bpmnElement="flow09"><di:waypoint x="1225" y="256" /><di:waypoint x="1270" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow10_di" bpmnElement="flow10"><di:waypoint x="1200" y="231" /><di:waypoint x="1200" y="130" /><di:waypoint x="1560" y="130" /><di:waypoint x="1560" y="216" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow11_di" bpmnElement="flow11"><di:waypoint x="1370" y="256" /><di:waypoint x="1415" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow12_di" bpmnElement="flow12"><di:waypoint x="1465" y="256" /><di:waypoint x="1510" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow13_di" bpmnElement="flow13"><di:waypoint x="1440" y="281" /><di:waypoint x="1440" y="555" /><di:waypoint x="1300" y="555" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow14_di" bpmnElement="flow14"><di:waypoint x="1610" y="256" /><di:waypoint x="1660" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow15_di" bpmnElement="flow15"><di:waypoint x="1710" y="256" /><di:waypoint x="1755" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow16_di" bpmnElement="flow16"><di:waypoint x="1685" y="281" /><di:waypoint x="1685" y="580" /><di:waypoint x="1325" y="580" /><di:waypoint x="1325" y="555" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow17_di" bpmnElement="flow17"><di:waypoint x="1560" y="308" /><di:waypoint x="1560" y="420" /><di:waypoint x="1520" y="420" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow18_di" bpmnElement="flow18"><di:waypoint x="1570" y="420" /><di:waypoint x="1648" y="420" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow19_di" bpmnElement="flow19"><di:waypoint x="1855" y="256" /><di:waypoint x="1905" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow20_di" bpmnElement="flow20"><di:waypoint x="2005" y="256" /><di:waypoint x="2055" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow21_di" bpmnElement="flow21"><di:waypoint x="2080" y="231" /><di:waypoint x="2080" y="160" /><di:waypoint x="2155" y="160" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow22_di" bpmnElement="flow22"><di:waypoint x="2080" y="281" /><di:waypoint x="2080" y="350" /><di:waypoint x="2155" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow23_di" bpmnElement="flow23"><di:waypoint x="2255" y="160" /><di:waypoint x="2330" y="160" /><di:waypoint x="2330" y="231" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow24_di" bpmnElement="flow24"><di:waypoint x="2255" y="350" /><di:waypoint x="2330" y="350" /><di:waypoint x="2330" y="281" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow25_di" bpmnElement="flow25"><di:waypoint x="2355" y="256" /><di:waypoint x="2400" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow26_di" bpmnElement="flow26"><di:waypoint x="1325" y="555" /><di:waypoint x="1400" y="555" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow27_di" bpmnElement="flow27"><di:waypoint x="1500" y="555" /><di:waypoint x="1560" y="555" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
```

> 节点说明：
> - **直属审批**（虚拟 `parent`）：`dsh:timeoutPolicy duration="PT2M" escalateToVirtualRole="parent"` ——8.2 链式 + 8.8a 超时升级。演示用 2 分钟，正式可改 PT24H。
> - **专线合规审批**（sameLine + 实体角色）：8.1/8.6 载体。DMN 判定 `level` 含"专线"时才走到。
> - **财务复核**（fixedUnit）：8.4 载体，`fixedUnitId` 占位符替换财务部 id；挂**非中断** Timer 边界（催办不取消任务）。
> - **出纳打款确认**（全公司 global）：8.8b 报错测试载体（见 §9.8）。其 timeoutPolicy 在正常场景不会触发——出纳 2 分钟内办完即无感。
> - **逐张发票复核**：ServiceTask 集合多实例，数组几个元素跑几份；引擎日志逐张输出（§7.1 delegate）。
> - **生成报销摘要**：Script Task juel 单表达式（无分号无 return），产出 `summary` 供审批 prompt 引用。

***

## 5. P2 BPMN XML：发文审批（三策略三个定义）

三个流程定义**只有「下级负责人会签」节点不同**（下表），其余 XML 完全一致。发布三次（每次改 process id/name 与会签节点配置）：

| 定义 | process id | 会签节点 multiInstanceLoopCharacteristics |
| --- | --- | --- |
| 单签 | `documentReviewSingle` | 并行 + 完成条件 `${nrOfCompletedInstances &gt;= 1}` |
| 会签 | `documentReviewCountersign` | 并行 + 完成条件留空 |
| 串签 | `documentReviewSequential` | **串行**（`isSequential="true"`）+ 完成条件留空 |

下面给出**会签版**完整 XML（另两版按上表改 3 处：process id、process name、multiInstanceLoopCharacteristics）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:flowable="http://flowable.org/bpmn" xmlns:dsh="http://dsh.ai/bpmn" id="DocumentReviewCountersign" targetNamespace="http://dsh.ai/docs">
  <bpmn2:process id="documentReviewCountersign" name="发文审批(会签)" isExecutable="true">
    <bpmn2:extensionElements>
      <dsh:contextVariables>
        <dsh:contextVariable name="initiator" type="object" description="流程发起人(启动时按登录人自动注入)" source="system">
          <dsh:field name="userId" type="string" description="Supabase Auth user.id" />
          <dsh:field name="name" type="string" description="显示名" />
          <dsh:field name="email" type="string" description="邮箱" />
        </dsh:contextVariable>
        <dsh:contextVariable name="title" type="string" description="发文标题" source="start-param" />
        <dsh:contextVariable name="content" type="string" description="发文正文" source="start-param" />
        <dsh:contextVariable name="polishedContent" type="string" description="AI 润色后的正文" />
        <dsh:contextVariable name="compliancePassed" type="boolean" description="AI 合规评审表决变量" />
        <dsh:contextVariable name="reviewNotes" type="string" description="AI 评审说明" />
        <dsh:contextVariable name="leaderOpinion" type="string" description="负责人会签意见" />
      </dsh:contextVariables>
    </bpmn2:extensionElements>
    <bpmn2:startEvent id="startEvent" name="开始" />
    <bpmn2:sequenceFlow id="flow01" sourceRef="startEvent" targetRef="polishContent" />
    <bpmn2:serviceTask id="polishContent" name="AI润色正文" flowable:async="true" flowable:delegateExpression="${dshBackendTaskDelegate}" flowable:failedJobRetryTimeCycle="R3/PT1M">
      <bpmn2:extensionElements>
        <dsh:backendTask>
          <dsh:backendProfile url="PROFILE_URL_1" />
        </dsh:backendTask>
        <dsh:userPrompt text="请润色以下发文正文，使其正式、简洁、保持原意，不要改变事实内容。输出包含 polishedContent（润色后的全文）字段的纯JSON。发文标题：《{{title}}》，正文：{{content}}" />
        <dsh:outputMappings>
          <dsh:mapping source="polishedContent" target="polishedContent" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow02" sourceRef="polishContent" targetRef="aiReview" />
    <bpmn2:serviceTask id="aiReview" name="多AI合规评审" flowable:async="true" flowable:delegateExpression="${dshBackendTaskDelegate}" flowable:failedJobRetryTimeCycle="R3/PT1M">
      <bpmn2:extensionElements>
        <dsh:backendTask>
          <dsh:backendProfile url="PROFILE_URL_1" />
          <dsh:backendProfile url="PROFILE_URL_2" />
        </dsh:backendTask>
        <dsh:votingRule variable="compliancePassed" passValue="true" passCount="1" />
        <dsh:userPrompt text="请审阅以下发文，从用词合规、格式规范角度评审。输出包含 compliancePassed（true/false）与 reviewNotes（评审说明）字段的纯JSON。标题：《{{title}}》，正文：{{polishedContent}}" />
        <dsh:outputMappings>
          <dsh:mapping source="compliancePassed" target="compliancePassed" />
          <dsh:mapping source="reviewNotes" target="reviewNotes" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn2:loopCardinality>2</bpmn2:loopCardinality>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow03" sourceRef="aiReview" targetRef="gatewayAiPass" />
    <bpmn2:exclusiveGateway id="gatewayAiPass" name="AI评审通过?" />
    <bpmn2:sequenceFlow id="flow04" sourceRef="gatewayAiPass" targetRef="approveByLeaders">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${dsh_passCount_aiReview &gt;= 1}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow05" sourceRef="gatewayAiPass" targetRef="notifyRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${dsh_passCount_aiReview &lt; 1}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="approveByLeaders" name="下级负责人会签">
      <bpmn2:extensionElements>
        <dsh:assignmentRule virtualRole="child" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 universal-approver skill 会签发文：《{{title}}》，正文：{{polishedContent}}。AI 评审意见：{{reviewNotes}}。输出包含 leaderOpinion（会签意见）的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="leaderOpinion" target="leaderOpinion" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics isSequential="false" />
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow06" sourceRef="approveByLeaders" targetRef="gatewaySplit" />
    <bpmn2:parallelGateway id="gatewaySplit" name="分流" />
    <bpmn2:sequenceFlow id="flow07" sourceRef="gatewaySplit" targetRef="archive" />
    <bpmn2:serviceTask id="archive" name="归档" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow08" sourceRef="gatewaySplit" targetRef="notifyDone" />
    <bpmn2:serviceTask id="notifyDone" name="通知发起人" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow09" sourceRef="archive" targetRef="gatewayJoin" />
    <bpmn2:sequenceFlow id="flow10" sourceRef="notifyDone" targetRef="gatewayJoin" />
    <bpmn2:parallelGateway id="gatewayJoin" name="汇聚" />
    <bpmn2:sequenceFlow id="flow11" sourceRef="gatewayJoin" targetRef="endEvent" />
    <bpmn2:endEvent id="endEvent" name="发文完成" />
    <bpmn2:serviceTask id="notifyRejected" name="通知发文被否" flowable:async="true" flowable:delegateExpression="${logDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow12" sourceRef="notifyRejected" targetRef="endRejected" />
    <bpmn2:endEvent id="endRejected" name="发文被否" />
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="documentReviewCountersign">
      <bpmndi:BPMNShape id="startEvent_di" bpmnElement="startEvent"><dc:Bounds x="150" y="238" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="polishContent_di" bpmnElement="polishContent"><dc:Bounds x="250" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="aiReview_di" bpmnElement="aiReview"><dc:Bounds x="430" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayAiPass_di" bpmnElement="gatewayAiPass" isMarkerVisible="true"><dc:Bounds x="590" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="approveByLeaders_di" bpmnElement="approveByLeaders"><dc:Bounds x="690" y="216" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewaySplit_di" bpmnElement="gatewaySplit" isMarkerVisible="true"><dc:Bounds x="840" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="archive_di" bpmnElement="archive"><dc:Bounds x="940" y="120" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyDone_di" bpmnElement="notifyDone"><dc:Bounds x="940" y="310" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayJoin_di" bpmnElement="gatewayJoin" isMarkerVisible="true"><dc:Bounds x="1090" y="231" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEvent_di" bpmnElement="endEvent"><dc:Bounds x="1190" y="238" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyRejected_di" bpmnElement="notifyRejected"><dc:Bounds x="700" y="430" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endRejected_di" bpmnElement="endRejected"><dc:Bounds x="860" y="452" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow01_di" bpmnElement="flow01"><di:waypoint x="186" y="256" /><di:waypoint x="250" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow02_di" bpmnElement="flow02"><di:waypoint x="350" y="256" /><di:waypoint x="430" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow03_di" bpmnElement="flow03"><di:waypoint x="530" y="256" /><di:waypoint x="590" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow04_di" bpmnElement="flow04"><di:waypoint x="640" y="256" /><di:waypoint x="690" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow05_di" bpmnElement="flow05"><di:waypoint x="615" y="281" /><di:waypoint x="615" y="470" /><di:waypoint x="700" y="470" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow06_di" bpmnElement="flow06"><di:waypoint x="790" y="256" /><di:waypoint x="840" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow07_di" bpmnElement="flow07"><di:waypoint x="865" y="231" /><di:waypoint x="865" y="160" /><di:waypoint x="940" y="160" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow08_di" bpmnElement="flow08"><di:waypoint x="865" y="281" /><di:waypoint x="865" y="350" /><di:waypoint x="940" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow09_di" bpmnElement="flow09"><di:waypoint x="1040" y="160" /><di:waypoint x="1115" y="160" /><di:waypoint x="1115" y="231" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow10_di" bpmnElement="flow10"><di:waypoint x="1040" y="350" /><di:waypoint x="1115" y="350" /><di:waypoint x="1115" y="281" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow11_di" bpmnElement="flow11"><di:waypoint x="1140" y="256" /><di:waypoint x="1190" y="256" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow12_di" bpmnElement="flow12"><di:waypoint x="800" y="470" /><di:waypoint x="860" y="470" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNDiagram>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
```

> 节点说明：
> - **title/content 声明为 `source="start-param"`**：启动必须传入，未传报错；员工端 `dsh_process_start_form` 会读出这两个声明供 AI 收集——这是阶段 7 发起链路的直接验证点。P1 无 start-param 声明，start-form 为空、可直接发起，两相对照。
> - **多 AI 合规评审**：2 个 profile 行（`PROFILE_URL_1/2`，可同值）+ `votingRule passCount="1"`（1 票通过即提前收，第 2 实例自动跳过）。若想看"两票全投"，把 passCount 改 2。
> - **下级负责人会签**（虚拟 `child`）：马总（总公司）发起 → 直接下级华东区+财务部的负责人（老周、钱姐）各一条待办。引擎部署时自动补 collection/assignee，无需手写。
> - backend task 失败语义：HTTP/超时/JSON 不合法 → async Job 按 `R3/PT1M` 重试 → 耗尽走失败路径（引擎日志可见，实例可终止重发）。

***

## 6. DMN XML（审批专线决策表）

保存为 `apps/flowable-engine/src/main/resources/dmn/orgRoutingLevel.dmn`。decision id 是 `orgRoutingLevel`，与 P1 中 ServiceTask 表达式 `decisionKey('orgRoutingLevel')` 对应。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             id="orgRoutingLevelDefs"
             name="orgRoutingLevel"
             namespace="http://dsh.ai/dmn2">

  <decision id="orgRoutingLevel" name="报销审批专线">
    <decisionTable id="orgRoutingLevelTable" hitPolicy="FIRST">
      <input id="in_amount" label="报销金额">
        <inputExpression id="in_amount_expr" typeRef="number" expressionLanguage="juel">
          <text>amount</text>
        </inputExpression>
      </input>
      <output id="out_level" name="level" label="审批专线" typeRef="string"/>

      <rule id="rule_1">
        <inputEntry id="ie_1_amount"><text>#{amount &gt;= 0 and amount &lt; 1000}</text></inputEntry>
        <outputEntry id="oe_1"><text>"直属主管"</text></outputEntry>
      </rule>
      <rule id="rule_2">
        <inputEntry id="ie_2_amount"><text>#{amount &gt;= 1000}</text></inputEntry>
        <outputEntry id="oe_2"><text>"直属主管+专线合规"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>
```

| 测试路径 | 金额 | 期望 level | 走到的节点 |
| --- | --- | --- | --- |
| 小额 | 500 | 直属主管 | 直属审批 → 财务复核 → 出纳 |
| 大额 | ≥1000 | 直属主管+专线合规 | 直属审批 → **专线审批** → 财务复核 → 出纳 |

***

## 7. JavaDelegate 完整代码（2 个文件）

复制到 `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/`，然后 `mvn compile` + 重启引擎。

### 7.1 InvoiceAuditDelegate —— 逐张发票复核（多实例元素注入）

```java
package com.dsh.flowable.delegate;

import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 逐张发票复核(演示版:日志代替 OCR 校验)。
 * BPMN: flowable:delegateExpression="${invoiceAuditDelegate}"
 * 多实例集合形式: flowable:collection="invoiceList" flowable:elementVariable="invoice"
 * 每个实例的 invoice 就是当前这张发票(Map)。
 */
@Component("invoiceAuditDelegate")
public class InvoiceAuditDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(InvoiceAuditDelegate.class);

    @Override
    @SuppressWarnings("unchecked")
    public void execute(DelegateExecution execution) {
        Map<String, Object> invoice = (Map<String, Object>) execution.getVariable("invoice");
        log.info("[发票复核] 第 {} 张: 发票号={}, 金额={}, 类型={}",
            execution.getVariable("loopCounter"),
            invoice.get("invoiceNo"), invoice.get("amount"), invoice.get("expenseType"));
        execution.setVariable("lastAuditedInvoiceNo", String.valueOf(invoice.get("invoiceNo")));
    }
}
```

### 7.2 LogDelegate —— 通用通知/归档（一个 bean 多处复用）

```java
package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 通用日志通知(演示版:所有通知/归档节点共用,按当前活动 id 区分场景)。
 * BPMN: flowable:delegateExpression="${logDelegate}"
 * 用于 notifyPayment/notifyDone/archive/urgeFinance/notifyRejected(P1)
 * 与 archive/notifyDone/notifyRejected(P2)。
 */
@Component("logDelegate")
public class LogDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(LogDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        Object summary = execution.hasVariable("summary") ? execution.getVariable("summary") : null;
        log.info("[{}] 流程实例 {} {}: {}",
            execution.getCurrentActivityName(),
            execution.getProcessInstanceId(),
            execution.getCurrentActivityId(),
            summary == null ? "变量: title=" + execution.getVariable("title") : summary);
        execution.setVariable("lastNotifyActivity", execution.getCurrentActivityId());
    }
}
```

***

## 8. SKILL.md（2 个）

### 8.1 报销单自动填写与票据审核（复用 v1）

P1 提交节点的 `expense-form-assistant` 与 v1 §6.1 **完全相同**，直接按 v1 文档创建，本文不重抄。其余节点统一用下方的通用审批 skill。

### 8.2 通用审批决策助手（直属/专线/财务复核/出纳/会签共用）

**目录**: `%USERPROFILE%\.dsh\skills\universal-approver\SKILL.md`

````markdown
---
name: universal-approver
description: 审批/复核/打款/会签场景的通用决策助手，按任务指令要求的字段输出结论 JSON
triggers:
  - 审批
  - 复核
  - 会签
---

# 通用审批决策助手

## 你要做的事

阅读任务指令中给出的单据信息（报销摘要、发票清单、发文正文等），做该角色应做的检查，给出结论。

## 检查口径（按指令信息可用性取舍）

- 金额合理性与事由匹配
- 发票要素（单张金额>0、日期距今≤365 天、类型与事由匹配、单张之和=合计）
- 合规性（超标准要说明理由）

## 输出

以任务指令中明确要求的 JSON 字段为准（如 approvalResult/approvalComment、financeVerified/financeNotes、paymentConfirmed/transactionId、leaderOpinion），字段一个不少，输出纯 JSON，不要夹带其他内容。

## 注意

- 打款类任务的 transactionId 用模拟号（如 20260921-0001），不要编造真实流水
- 结论与意见要有依据，不复读指令
````

***

## 9. 分步操作手册

### 阶段一：准备文件

1. DMN → `apps/flowable-engine/src/main/resources/dmn/orgRoutingLevel.dmn`
2. 两个 delegate → `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/`
3. `mvn compile -q`
4. 两个 SKILL.md → `%USERPROFILE%\.dsh\skills\...`

### 阶段二：启动服务

终端 A（引擎，确认日志搜到 `orgRoutingLevel`）、B1（后端）、B2（前端）、C（员工端）按 v1 §1；跑 P2 前再起终端 D（backend profile，本文 §2.1）。

### 阶段三：建布景（顺序执行）

1. **建 8 个 Supabase Auth 用户**（v1 §7 阶段三同法）→ Web Console 用户管理逐个审批为 `active`
2. **建应用**：如"集团协同"，状态 active
3. **建组织树**：组织管理页按 §1.1 逐级创建（总公司 → 华东区 → A/B；总公司 → 财务部），**每建一级就指定负责人**（马总/老周/张三/李四/钱姐）。负责人保存后引擎自动把该人 upsert 进 `org_unit_members`
4. **补成员归属**：用户管理页逐个编辑"所属部门"（多选）——小王勾 A；**小陈勾 A + B**（多对多核心布景）；其余人已随负责人自动带入
5. **建 4 个角色 + 加成员**（应用详情 → 角色）：
   | 角色 | 成员 |
   | --- | --- |
   | 报销人 | 马总、老周、张三、李四、小王、小陈 |
   | 审批专员 | 老周、小陈 |
   | 财务复核员 | 钱姐、小钱 |
   | 出纳 | 小钱、小陈 |
6. **记 9 个 UUID**（5 部门 + 4 角色）→ 做 §1.4 全局替换

### 阶段四：发布流程

1. P1 XML → 粘贴 → 校验 → 发布（校验会查：orgScope 枚举、virtualRole 与 candidateRoleId 互斥、fixedUnitId 存在性、多实例配置）
2. P2 三个定义逐个发布（§5 的 3 处差异逐版修改）
3. v1 差旅报销流程若库中没有，按 v1 §7 阶段四发布（8.7 用）

### 阶段五：八场景执行手册

> 通用操作：员工端切换用户 = 退出登录再登录；每条待办"打开 → AI 对话 → 确认 JSON → 提交待办 → 映射确认"。
> P1 发起：用**员工端 AI 发起**（对 AI 说"帮我发起费用报销"——走 `dsh_process_list` → `dsh_process_start` 链路）；需要精确控制 orgUnitId 的场景（8.5）用 **Web Console 启动实例对话框**（有身份下拉）。

#### 8.1 A/B 部门隔离（大额 ≥1000 才走专线节点）

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 小王以 A 部门身份发起 P1（大额，如 1500） | 直属审批待办出现在**张三** |
| 2 | 张三通过 | **小陈**收到"专线合规审批"待办（A 部门内第一个审批专员，**不是**华东区的老周） |
| 3 | 登录李四 | 待办列表**无**这条专线待办（B 部门不可见） |
| 4 | 登录老周 | 待办列表**无** A 线专线待办（华东区虽有审批专员角色成员，但不在 A 部门——"从下往上找第一个"不上翻到上级部门；老周角色成员身份是为反证"不会越级解析到老周"） |
| 5 | 小陈以 B 部门身份发起 P1（大额） | 专线待办仍解析到小陈自己（B 线成员）；**跳过申请人本人**规则生效——若 B 线还有第二个审批专员则应由其收 |

#### 8.2 上一级链（小额 500，直属审批节点）

同一流程四个身份各发起一次，观察直属审批的 assignee：

| 发起人 | 发起身份 | 直属审批待办 | 依据 |
| --- | --- | --- | --- |
| 小王 | A 部门 | 张三 | A 的 parent |
| 张三 | A 部门 | 老周 | A 的 parent=华东区 |
| 老周 | 华东区 | 马总 | 华东区的 parent |
| 马总 | 总公司 | **无待办，节点自动通过** | 已到顶；Web Console 实例详情可见审计"审批人到顶自动通过"，流程继续走到财务复核 |

#### 8.3 发文会签（P2 三定义，马总发起）

| 定义 | 操作 | 预期 |
| --- | --- | --- |
| single | 马总发起（员工端对 AI 说"发起发文审批（单签），标题…正文…"，AI 经 start-form 收集 title/content） | 老周、钱姐**同时**各收一条待办；任一人提交后另一人待办**自动消失**，流程进归档 |
| countersign | 同上（会签版） | 两人待办同时出现；**两人都提交**后才走归档 |
| sequential | 同上（串签版） | 待办**逐个出现**（按候选顺序），第一人提交后第二人才收到 |

附加断言：backend profile 注册表中 P2 的 profile 引用为 active；引擎日志可见 `[AI润色正文]`/`[多AI合规评审]` delegate 执行痕迹与变量写入。

#### 8.4 指定部门（P1 走到财务复核节点）

8.1/8.2 的实例自然走到财务复核。断言：待办仅出现在**钱姐与小钱**（财务部子树内财务复核员）；张三/李四/小陈/老周均不可见。催办断言：钱姐 2 分钟不处理 → 引擎日志出现 `[自动催办复核]`，**待办仍在**（非中断）。

#### 8.5 多身份发起（小陈，P1）

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 员工端小陈对 AI 说"帮我发起费用报销" | AI 从身份块看到两个组织位置，**主动询问以哪个身份发起**（process-start 工具 description 约定的交互） |
| 2 | 回答"以 A 部门身份" | AI 带 orgUnitId=ORG_A_UUID 调 start；直属审批=张三（A 线） |
| 3 | 再发起一笔，回答"以 B 部门身份" | 直属审批=李四（B 线） |
| 4 | Web Console 启动实例对话框选小陈账号发起、**不选身份**直接提交 | 报错"存在多个组织身份，请选择发起身份" |
| 5 | API 伪造（见下） | 403/400，报错明示 orgUnitId 不在本人归属中 |

伪造测试命令（以小陈身份拿 JWT 后直接 POST，orgUnitId 传他不在的财务部）：

```powershell
$resp = Invoke-RestMethod -Method Post -Uri "https://<project-ref>.supabase.co/auth/v1/token?grant_type=password" `
  -Headers @{ apikey = "<anon key>" } `
  -ContentType "application/json" `
  -Body '{"email":"xiaochen@dsh.local","password":"<密码>"}'
$jwt = $resp.access_token
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/process-instances" `
  -Headers @{ authorization = "Bearer $jwt" } -ContentType "application/json" `
  -Body '{"workflowDefinitionId":"<P1定义id>","orgUnitId":"ORG_FINANCE_UUID"}'
# 预期: 4xx，错误信息指明 orgUnitId 不属于发起人
```

#### 8.6 跨部门成员判定

与 8.1 步骤 2/5 合并观察：小王（A 线）与李四或小陈-B（B 线）各自发起后，**小陈两条线的"专线合规审批"待办都能收到**（候选解析按 `org_unit_members` 多对多，各隶属线独立判定）。

#### 8.7 存量流程回归

v1 差旅报销（无 orgScope）按 v1 §7 阶段五原样重跑一笔。断言：候选=全公司角色成员（不按部门过滤）；发起不需要 orgUnitId（无 sameLine 节点）；整体行为与升级前一致。

#### 8.8 超时升级

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| a | 8.2 的任一笔小额实例走到直属审批后，**张三（或对应审批人）2 分钟不处理** | 原待办取消，升级目标（审批人的父部门负责人）收到待办：小王那笔 → 张三超时 → **老周**接管（升级锚=任务局部变量 `dsh_assignment_org_unit`=A 部门，parent=华东区） |
| b | 专测前置：把出纳角色成员**临时改为仅小陈**（避免小钱竞争 single 收工），发起 P1 走到出纳节点后 2 分钟不处理 | **报错不静默**：global 待办无局部变量锚点 → 回退映射表 → 小陈有 A/B 两个部门 → 引擎日志报"审批人组织身份不唯一，无法定位升级链"，任务保留、实例可见失败信息（测完把小钱加回出纳角色） |

> 8.8b 的预期失败会留下需要管理员干预的实例（终止即可）。这是**设计内行为**（fail loud），不是缺陷。

### 阶段六：组件走查清单（对照教程）

跑完上述场景后逐项打勾：

- [ ] UserTask 多实例·单人：P1 五个审批节点（任一人提交、其余待办自动删）
- [ ] UserTask 多实例·会签/串签：P2 countersign/sequential 两定义
- [ ] votingRule 计票：P2 多 AI 评审（第 1 票通过即收、第 2 实例自动跳过）
- [ ] ServiceTask 集合多实例：P1 逐张发票复核（3 张发票=3 份，引擎日志 3 行）
- [ ] backend task 单实例：P2 AI 润色（result JSON 按输出映射写 polishedContent）
- [ ] backend task 多实例：P2 多 AI 评审（2 个 profile 行=2 实例）
- [ ] Service Task + async + 重试：P1/P2 通知节点（引擎日志 + ACT_RU_JOB 出现过）
- [ ] Script Task juel：P1 摘要（实例变量 `summary` 值正确）
- [ ] DMN：P1 大额/小额两路径的 `level` 值
- [ ] 排他网关 ×5、并行网关 ×2（P1/P2 收尾分流汇聚）
- [ ] Timer 边界·非中断：P1 催办（任务保留）
- [ ] timeoutPolicy 升级：P1 直属审批（8.8a）

### 常见问题

| 现象 | 原因 |
| --- | --- |
| 发布校验拒绝"virtualRole 与 candidateRoleId 共存" | 属性面板残留了候选角色，虚拟角色节点的候选角色必须清空 |
| 会签节点粘贴后无人收到待办 | userTask 多实例块被删（引擎只认多实例派发）或角色没加成员 |
| child 扇出启动即报错 | 发起人部门的直接下级没有部门/负责人（数据没建全，属预期 fail loud） |
| P2 卡在 AI 润色不动 | backend profile 未启动或 URL 未注册（注册表 inactive）；重试耗尽后引擎日志见失败 Job |
| 到顶没自动通过而是报错"未配置负责人" | 中间某级部门没指负责人（数据缺失与结构到顶是两类行为，见设计文档 §5.3） |
