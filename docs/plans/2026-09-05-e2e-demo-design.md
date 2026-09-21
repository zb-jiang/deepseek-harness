# 端到端 DEMO：AI 增强的差旅报销审批

> 目的：一次跑通 DSH Web Console + Flowable 引擎 + DSH 员工端 Skill 的完整链路。
> 覆盖组件：User Task ×6（全部多实例指派：5 个 single=并行多实例任一人提交即办结，1 个会签 2/3 一票否决）、Service Task ×5（自定义 JavaDelegate：1 个自动催办 + 3 个异步通知，通知均为异步+重试；1 个 DMN 决策表达式）、DMN 决策表（经 serviceTask 表达式调 dmnRuleService 执行——businessRuleTask 元素在 Flowable 7 中是 Drools 专用路径，expression 属性被解析器忽略，缺 kie-api 依赖时部署直接失败，故不用）、Exclusive Gateway ×7、Timer Boundary Event ×2（主管超时升级=中断；出纳 24h 未打款催办=非中断）。

> 为什么通知用 Service Task 而不是 Send Task：Flowable 发布校验器（flowable-executable-process）要求 sendTask 必须配 `type` 或 `operation` 属性，`delegateExpression` 不被认作合法实现；demo 的通知本质是 JavaDelegate 调用，Service Task 语义准确且校验直接放行。
>
> 发起人身份：上下文声明 `initiator`（`source="system"`）由 web-console 启动时按登录人自动注入（userId/name/email），所有 prompt 的 `{{initiator.name}}` 即申请人，员工不再手填姓名；调用方传入或任务提交覆盖该变量均被拒绝。
>
> 本文档自包含：所有 XML / Java / SKILL.md 全部给出，复制即可用。

***

## 0. 场景与角色设计

员工提交差旅报销（多张发票上传，AI 逐张提取信息、审核要素、算好合计，提交时一次完成）→ DMN 按发票合计金额决定审批层级 → 直属主管 → （中额）部门经理 → （大额）费用专员会签 2/3 → 财务专员验票 → 通知出纳打款 → 出纳打款确认（挂 24h **非中断**边界定时器：到点未打款发一次催打提醒，任务保留继续等打款）→ 通知员工到账（打款确认完成后立即发）。**任一审批环节或财务验票拒绝 → 汇聚到"通知报销被拒" → 流程结束**（主管 / 经理 / 终审 / 验票各有"通过?"网关，reject 走汇聚分支）。

### 0.1 角色与用户

**部门经理和费用专员是平行角色**（都是顶级角色，无父角色），审批先后由 DMN 决策表 + 排他网关决定，与角色层级无关。角色层级只用于测试"父角色有活跃子角色时不能停用"等守卫。

| 角色名  | 父角色  | 用户          | 职责            |
| ---- | ---- | ----------- | ------------- |
| 报销人  | 直属主管 | 张三、李四       | 提交报销单（第一个待办）  |
| 直属主管 | 部门经理 | 王主管         | 小额/中额/大额第一道审批 |
| 部门经理 | 无    | 赵经理         | 中额/大额第二道审批    |
| 费用专员 | 无    | 陈专员、孙专员、周专员 | 大额终审（会签 2/3）  |
| 财务专员 | 无    | 钱财务         | 票据验真          |
| 出纳   | 费用专员 | 孙出纳         | 打款确认          |

> ⚠️ 下文 BPMN XML 中的角色引用是 6 个占位符（`ROLE_SUBMITTER_UUID` 等），复制前全部替换成你在 Web Console 创建的实际角色 UUID（应用详情 → 角色 → 复制 ID）。

### 0.2 自动节点与 DSH headless 集成说明

本 DEMO **没有自动（LLM）节点**：发票的信息提取与要素审核并入第一个 user task（员工提交报销单），由员工端 skill（§6.1）在一次会话里完成——AI 逐张提取发票字段、审核要素（金额>0、开票日期距今≤30天、类型映射）、算好合计金额，员工核对后随提交 JSON 一次写入流程上下文。

引擎侧的自动（LLM）节点机制后来由 **DSH backend task + backend profile** 承接（见 `2026-09-14-dsh-backend-task-design.md`，`apps/flowable-engine/.../delegate/DshBackendTaskDelegate.java`）：画布上拖 DSH backend task 节点配置 userPrompt/skillRefs/outputMappings，引擎 delegate 通过 HTTP 调用常驻 backend profile 实例生成 JSON 并按输出映射写流程变量。

因此本 DEMO 的引擎终端**不需要** `DEEPSEEK_API_KEY` / DSH 仓库/Node；员工端 skill 用的 key 在 §1.3 终端 C 设置。

### 0.3 端口总览

| 服务             | 端口   | 说明                      |
| -------------- | ---- | ----------------------- |
| Flowable 引擎    | 8090 | REST + 员工端任务代理          |
| Web Console 后端 | 8080 | 治理 API                  |
| Web Console 前端 | 5173 | Vite dev                |
| DSH 员工端        | 默认   | enterprise profile 自动分配 |

***

## 1. 启动准备（按顺序做一遍）

### 1.0 前提

- Supabase 项目已按 [2026-08-19-supabase-setup-guide.md](2026-08-19-supabase-setup-guide.md) 建好（表结构 + 注册 trigger + RLS）。
- `pnpm install` 已在仓库根目录执行过。
- 三个 `.env` 文件就绪（**已存在的核对即可，不用重做**）：

**文件 1**：`apps/flowable-engine/.env.ps1`

```powershell
$env:SUPABASE_DB_HOST="<Supabase pooler 域名,见 setup guide §2.2>"
$env:SUPABASE_DB_USER="<postgres.<project-ref>>"
$env:SUPABASE_DB_PASSWORD="<数据库密码>"
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
```

> 引擎不读 `DSH_WEB_PROFILE_BASE_URL`（历史遗留变量，代码已无引用）。`DEEPSEEK_API_KEY` 本 DEMO 不需要（见 §0.2；引擎侧无 LLM 集成）。

**文件 2**：`apps/web-console/backend/.env.ps1`（变量集与文件 1 不同：多 `FLOWABLE_BASE_URL`，少其余）

```powershell
$env:SUPABASE_DB_HOST="<同文件 1>"
$env:SUPABASE_DB_USER="<同文件 1>"
$env:SUPABASE_DB_PASSWORD="<同文件 1>"
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:FLOWABLE_BASE_URL="http://127.0.0.1:8090"   # 后端调 Flowable REST 的地址
```

**文件 3**：`apps/web-console/frontend/.env.local`

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key,见 setup guide §2.1>
VITE_API_BASE_URL=
```

### 1.1 终端 A：Flowable 引擎

```powershell
cd d:\works\deepseek-harness\apps\flowable-engine
.\.env.ps1                        # 每次开新终端都要先加载环境变量
mvn spring-boot:run
# 日志出现 "Started FlowableEngineApplication" 即就绪
```

### 1.2 终端 B：Web Console 后端 + 前端（两个终端窗口）

```powershell
# 终端 B1（后端）
cd d:\works\deepseek-harness\apps\web-console\backend
.\.env.ps1
mvn spring-boot:run
# 日志出现 "Started WebConsoleApplication" 即就绪

# 终端 B2（前端）
cd d:\works\deepseek-harness\apps\web-console\frontend
pnpm install                      # 首次
pnpm dev
# 浏览器打开 http://localhost:5173
```

### 1.3 终端 C：DSH 员工端（enterprise profile）

一个终端就够，切换用户 = 退出登录再登录。

```powershell
cd d:\works\deepseek-harness
pnpm run build                    # 仓库改动后需要；没改过可跳过
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:SUPABASE_ANON_KEY="<anon key>"
$env:FLOWABLE_ENGINE_URL="http://127.0.0.1:8090"   # 员工端任务代理指向 Flowable 引擎
$env:DEEPSEEK_API_KEY="<你的 LLM key>"   # skill 执行需要
pnpm dsh --profile enterprise
# 启动后浏览器自动打开 DSH 员工端登录页（邮箱 + 密码 = Supabase Auth 账号）
```

> 环境变量必须在**同一个 PowerShell 会话**里设置后再启动；每次新开终端都要重新设置。

***

## 2. 文件清单 & 复制位置

| # | 文件                   | 复制到                                                                          | 后续动作                 |
| - | -------------------- | ---------------------------------------------------------------------------- | -------------------- |
| 1 | DMN XML（§4）          | `apps/flowable-engine/src/main/resources/dmn/approvalLevel.dmn`（新建 `dmn` 目录） | 重启引擎生效               |
| 2 | 3 个 JavaDelegate（§5） | `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/`              | `mvn compile` + 重启引擎 |
| 3 | BPMN XML（§3）         | 不落盘：Web Console 画布里粘贴（§7 步骤 7）                                               | 无                    |
| 4 | 6 个 SKILL.md（§6）     | `%USERPROFILE%\.dsh\skills\<skill名>\SKILL.md`（目录自己建）                         | DSH 自动扫描，无需重启        |

***

## 3. BPMN XML（完整流程图，含画布坐标）

> 复制前先做**全局替换**（6 个占位符 → 实际角色 UUID）：
>
> | 占位符                        | 替换为       |
> | -------------------------- | --------- |
> | `ROLE_SUBMITTER_UUID`      | 报销人角色 ID  |
> | `ROLE_DIRECT_MANAGER_UUID` | 直属主管角色 ID |
> | `ROLE_DEPT_MANAGER_UUID`   | 部门经理角色 ID |
> | `ROLE_CFO_UUID`            | 费用专员角色 ID |
> | `ROLE_FINANCE_UUID`        | 财务专员角色 ID |
> | `ROLE_CASHIER_UUID`        | 出纳角色 ID   |
>
> XML 末尾的 `<bpmndi:BPMNDiagram>` 段是画布坐标（DI），**必须保留**——删掉它画布导入后是空白的。
>
> **每个 userTask 都带** **`<bpmn2:multiInstanceLoopCharacteristics>`** **块，不能删**：引擎的指派机制只认多实例——部署时自动把候选角色成员列表注入 collection、每个成员一条任务并直接 assignee（员工端"我的待办"只查 assignee=自己）。单实例 userTask 没有 assignee 也没有候选人，任务会挂起来谁都看不见。single = 并行多实例 + `${nrOfCompletedInstances >= 1}`（任一人提交即办结，其余人待办自动删除）；会签 2/3 见费用专员终审节点；画布上手工加等价配置 = 扳手菜单选并行多实例图标 + 属性面板填完成条件。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:flowable="http://flowable.org/bpmn" xmlns:dsh="http://dsh.ai/bpmn" id="ExpenseReimbursement" targetNamespace="http://dsh.ai/expense">
  <bpmn2:process id="expenseReimbursement" name="差旅报销审批" isExecutable="true">
    <bpmn2:extensionElements>
      <dsh:contextVariables>
        <dsh:contextVariable name="initiator" type="object" description="流程发起人(启动时按登录人自动注入,不允许提交)" source="system">
          <dsh:field name="userId" type="string" description="Supabase Auth user.id" />
          <dsh:field name="name" type="string" description="显示名" />
          <dsh:field name="email" type="string" description="邮箱" />
        </dsh:contextVariable>
        <dsh:contextVariable name="amount" type="float" description="报销金额(发票合计)" />
        <dsh:contextVariable name="reason" type="string" description="报销事由" />
        <dsh:contextVariable name="invoiceList" type="array" description="发票清单(员工提交时 AI 逐张提取)" itemType="object">
          <dsh:field name="invoiceNo" type="string" description="发票号" />
          <dsh:field name="amount" type="float" description="单张发票金额" />
          <dsh:field name="issuedOn" type="date" description="开票日期" />
          <dsh:field name="expenseType" type="string" description="发票类型" />
        </dsh:contextVariable>
        <dsh:contextVariable name="auditPassed" type="boolean" description="票据审核是否通过(员工提交时 AI 审核)" />
        <dsh:contextVariable name="auditNotes" type="string" description="票据审核说明(员工提交时 AI 审核)" />
        <dsh:contextVariable name="level" type="string" description="审批层级(DMN 产出)" />
        <dsh:contextVariable name="approvalResult" type="string" description="审批结论(approve/reject)" />
        <dsh:contextVariable name="approvalComment" type="string" description="审批意见" />
        <dsh:contextVariable name="financeVerified" type="boolean" description="票据验真是否通过" />
        <dsh:contextVariable name="financeNotes" type="string" description="票据审核说明" />
        <dsh:contextVariable name="paymentConfirmed" type="boolean" description="打款是否完成" />
        <dsh:contextVariable name="transactionId" type="string" description="打款流水号" />
        <dsh:contextVariable name="urgentNotified" type="boolean" description="内部标记:已超时催办出纳" />
        <dsh:contextVariable name="employeeNotified" type="boolean" description="内部标记:已通知员工结果(到账/被拒)" />
        <dsh:contextVariable name="applicantName" type="string" />
      </dsh:contextVariables>
    </bpmn2:extensionElements>
    <bpmn2:startEvent id="startEvent" name="开始" />
    <bpmn2:sequenceFlow id="flow_start_submit" sourceRef="startEvent" targetRef="submitExpense" />
    <bpmn2:userTask id="submitExpense" name="员工提交报销单">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_SUBMITTER_UUID" />
        <dsh:skillRef>expense-form-assistant</dsh:skillRef>
        <dsh:userPrompt text="请说明报销事由并上传本次全部发票（可多张）。调用 expense-form-assistant skill 逐张提取发票信息（发票号、金额、开票日期、类型）、做要素审核并计算合计金额，最后输出纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="amount" target="amount" />
          <dsh:mapping source="reason" target="reason" />
          <dsh:mapping source="invoiceList" target="invoiceList" />
          <dsh:mapping source="auditPassed" target="auditPassed" />
          <dsh:mapping source="auditNotes" target="auditNotes" />
          <dsh:mapping source="applicantName" target="applicantName" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow_submit_rule" sourceRef="submitExpense" targetRef="decideLevel" />
    <bpmn2:serviceTask id="decideLevel" name="DMN:决定审批层级" flowable:expression="${execution.setVariables(dmnRuleService.createExecuteDecisionBuilder().decisionKey(&#39;approvalLevel&#39;).variables(execution.getVariables()).executeWithSingleResult())}" />
    <bpmn2:sequenceFlow id="flow_rule_submit" sourceRef="decideLevel" targetRef="directManagerApprove" />
    <bpmn2:userTask id="directManagerApprove" name="直属主管审批">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_DIRECT_MANAGER_UUID" />
        <dsh:skillRef>direct-manager-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 direct-manager-approver skill 审批 {{applicantName}} 的差旅报销：事由「{{reason}}」，发票合计 {{amount}} 元，发票清单 {{invoiceList}}，AI 预审 {{auditPassed}}/{{auditNotes}}。核对是否符合部门规定，输出包含 approvalResult（approve/reject）与 approvalComment 的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:boundaryEvent id="boundaryTimeoutDirectMgr" name="24h超时升级" attachedToRef="directManagerApprove">
      <bpmn2:timerEventDefinition id="timerDirectMgr">
        <bpmn2:timeDuration xsi:type="bpmn2:tFormalExpression">PT4M</bpmn2:timeDuration>
      </bpmn2:timerEventDefinition>
    </bpmn2:boundaryEvent>
    <bpmn2:sequenceFlow id="flow_direct_to_gateway1" sourceRef="directManagerApprove" targetRef="gatewayMgrOutcome" />
    <bpmn2:sequenceFlow id="flow_timeout_to_dept" sourceRef="boundaryTimeoutDirectMgr" targetRef="deptManagerApprove" />
    <bpmn2:exclusiveGateway id="gatewayMgrOutcome" name="主管通过?" />
    <bpmn2:sequenceFlow id="flow_mgr_pass" sourceRef="gatewayMgrOutcome" targetRef="gatewayNeedDept">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_mgr_reject" sourceRef="gatewayMgrOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:exclusiveGateway id="gatewayNeedDept" name="还要经理?" />
    <bpmn2:sequenceFlow id="flow_g1_yes" sourceRef="gatewayNeedDept" targetRef="deptManagerApprove">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${level.contains('部门经理')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_g1_no" sourceRef="gatewayNeedDept" targetRef="gatewayNeedCfo">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!level.contains('部门经理')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="deptManagerApprove" name="部门经理审批">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_DEPT_MANAGER_UUID" />
        <dsh:skillRef>dept-manager-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 dept-manager-approver skill 审批 {{applicantName}} 的差旅报销：发票合计 {{amount}} 元，事由「{{reason}}」，直属主管意见：{{approvalComment}}。核对预算与合规性，输出包含 approvalResult（approve/reject）与 approvalComment的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow_dept_to_gateway2" sourceRef="deptManagerApprove" targetRef="gatewayDeptOutcome" />
    <bpmn2:exclusiveGateway id="gatewayDeptOutcome" name="经理通过?" />
    <bpmn2:sequenceFlow id="flow_dept_pass" sourceRef="gatewayDeptOutcome" targetRef="gatewayNeedCfo">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_dept_reject" sourceRef="gatewayDeptOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:exclusiveGateway id="gatewayNeedCfo" name="还要费用专员?" />
    <bpmn2:sequenceFlow id="flow_g2_yes" sourceRef="gatewayNeedCfo" targetRef="cfoFinalApprove">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${level.contains('费用专员')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_g2_no" sourceRef="gatewayNeedCfo" targetRef="financeVerify">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!level.contains('费用专员')}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="cfoFinalApprove" name="费用专员终审">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_CFO_UUID" />
        <dsh:skillRef>cfo-final-approver</dsh:skillRef>
        <dsh:userPrompt text="请调用 cfo-final-approver skill 终审 {{applicantName}} 的大额差旅报销：发票合计 {{amount}} 元，发票清单 {{invoiceList}}，前序审批意见：{{approvalComment}}。核对预算总览与合规性，输出包含 approvalResult（approve/reject）与 approvalComment的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${approvalResult == 'reject' || nrOfCompletedInstances &gt;= 2}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow_cfo_to_gate" sourceRef="cfoFinalApprove" targetRef="gatewayCfoOutcome" />
    <bpmn2:exclusiveGateway id="gatewayCfoOutcome" name="终审通过?" />
    <bpmn2:sequenceFlow id="flow_cfo_pass" sourceRef="gatewayCfoOutcome" targetRef="financeVerify">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_cfo_reject" sourceRef="gatewayCfoOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="financeVerify" name="财务专员票据审核">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_FINANCE_UUID" />
        <dsh:skillRef>invoice-verifier</dsh:skillRef>
        <dsh:userPrompt text="请调用 invoice-verifier skill 验票：发票清单 {{invoiceList}}，发票合计 {{amount}} 元。核对发票要素、金额勾稽与日期，输出包含 financeVerified（true/false）与 financeNotes 的纯JSON格式。" />
        <dsh:outputMappings>
          <dsh:mapping source="financeVerified" target="financeVerified" />
          <dsh:mapping source="financeNotes" target="financeNotes" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow_finance_to_gate" sourceRef="financeVerify" targetRef="gatewayFinOutcome" />
    <bpmn2:exclusiveGateway id="gatewayFinOutcome" name="验票通过?" />
    <bpmn2:sequenceFlow id="flow_finance_pass" sourceRef="gatewayFinOutcome" targetRef="notifyPayment">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow_finance_reject" sourceRef="gatewayFinOutcome" targetRef="gatewayRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:exclusiveGateway id="gatewayRejected" name="存在拒绝" />
    <bpmn2:sequenceFlow id="flow_rejected_notify" sourceRef="gatewayRejected" targetRef="notifyRejected" />
    <bpmn2:serviceTask id="notifyRejected" name="通知报销被拒" flowable:async="true" flowable:delegateExpression="${notifyEmployeeDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow_rejected_end" sourceRef="notifyRejected" targetRef="endEventRejected" />
    <bpmn2:endEvent id="endEventRejected" name="报销被拒" />
    <bpmn2:serviceTask id="notifyPayment" name="通知出纳打款" flowable:async="true" flowable:delegateExpression="${notifyPaymentDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow_notify_cashier" sourceRef="notifyPayment" targetRef="cashierConfirm" />
    <bpmn2:userTask id="cashierConfirm" name="出纳打款确认">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="ROLE_CASHIER_UUID" />
        <dsh:skillRef>cashier-payment</dsh:skillRef>
        <dsh:userPrompt text="请调用 cashier-payment skill 执行打款：收款人 {{applicantName}}，金额 {{amount}} 元，事由 {{reason}}。网银打款完成后输出包含 paymentConfirmed=true 与 transactionId（交易流水号）字段的纯JSON。" />
        <dsh:outputMappings>
          <dsh:mapping source="paymentConfirmed" target="paymentConfirmed" />
          <dsh:mapping source="transactionId" target="transactionId" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:boundaryEvent id="boundaryPayUrge" name="24h未打款催办" cancelActivity="false" attachedToRef="cashierConfirm">
      <bpmn2:timerEventDefinition id="timerPayUrge">
        <bpmn2:timeDuration xsi:type="bpmn2:tFormalExpression">PT4M</bpmn2:timeDuration>
      </bpmn2:timerEventDefinition>
    </bpmn2:boundaryEvent>
    <bpmn2:sequenceFlow id="flow_cashier_notify" sourceRef="cashierConfirm" targetRef="notifyEmployee" />
    <bpmn2:serviceTask id="urgeCashier" name="自动催打出纳" flowable:delegateExpression="${notifyUrgentDelegate}" />
    <bpmn2:sequenceFlow id="flow_urge_go" sourceRef="boundaryPayUrge" targetRef="urgeCashier" />
    <bpmn2:endEvent id="endEventUrged" name="已催打" />
    <bpmn2:sequenceFlow id="flow_urge_done" sourceRef="urgeCashier" targetRef="endEventUrged" />
    <bpmn2:serviceTask id="notifyEmployee" name="通知员工报销到账" flowable:async="true" flowable:delegateExpression="${notifyEmployeeDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:endEvent id="endEvent" name="结束" />
    <bpmn2:sequenceFlow id="flow_notify_end" sourceRef="notifyEmployee" targetRef="endEvent" />
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="expenseReimbursement">
      <bpmndi:BPMNShape id="startEvent_di" bpmnElement="startEvent">
        <dc:Bounds x="150" y="218" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="submitExpense_di" bpmnElement="submitExpense">
        <dc:Bounds x="250" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="decideLevel_di" bpmnElement="decideLevel">
        <dc:Bounds x="700" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="directManagerApprove_di" bpmnElement="directManagerApprove">
        <dc:Bounds x="960" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayMgrOutcome_di" bpmnElement="gatewayMgrOutcome" isMarkerVisible="true">
        <dc:Bounds x="1110" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayNeedDept_di" bpmnElement="gatewayNeedDept" isMarkerVisible="true">
        <dc:Bounds x="1210" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="deptManagerApprove_di" bpmnElement="deptManagerApprove">
        <dc:Bounds x="1310" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayDeptOutcome_di" bpmnElement="gatewayDeptOutcome" isMarkerVisible="true">
        <dc:Bounds x="1460" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayNeedCfo_di" bpmnElement="gatewayNeedCfo" isMarkerVisible="true">
        <dc:Bounds x="1560" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="cfoFinalApprove_di" bpmnElement="cfoFinalApprove">
        <dc:Bounds x="1660" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayCfoOutcome_di" bpmnElement="gatewayCfoOutcome" isMarkerVisible="true">
        <dc:Bounds x="1810" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="financeVerify_di" bpmnElement="financeVerify">
        <dc:Bounds x="1910" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayFinOutcome_di" bpmnElement="gatewayFinOutcome" isMarkerVisible="true">
        <dc:Bounds x="2060" y="211" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayRejected_di" bpmnElement="gatewayRejected" isMarkerVisible="true">
        <dc:Bounds x="1575" y="495" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyRejected_di" bpmnElement="notifyRejected">
        <dc:Bounds x="1700" y="480" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEventRejected_di" bpmnElement="endEventRejected">
        <dc:Bounds x="1850" y="502" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyPayment_di" bpmnElement="notifyPayment">
        <dc:Bounds x="2160" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="cashierConfirm_di" bpmnElement="cashierConfirm">
        <dc:Bounds x="2320" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="urgeCashier_di" bpmnElement="urgeCashier">
        <dc:Bounds x="2510" y="264" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEventUrged_di" bpmnElement="endEventUrged">
        <dc:Bounds x="2660" y="286" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyEmployee_di" bpmnElement="notifyEmployee">
        <dc:Bounds x="2770" y="196" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEvent_di" bpmnElement="endEvent">
        <dc:Bounds x="2930" y="218" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="boundaryPayUrge_di" bpmnElement="boundaryPayUrge">
        <dc:Bounds x="2352" y="258" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="boundaryTimeoutDirectMgr_di" bpmnElement="boundaryTimeoutDirectMgr">
        <dc:Bounds x="992" y="158" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow_start_submit_di" bpmnElement="flow_start_submit">
        <di:waypoint x="186" y="236" />
        <di:waypoint x="250" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_submit_rule_di" bpmnElement="flow_submit_rule">
        <di:waypoint x="350" y="236" />
        <di:waypoint x="700" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_rule_submit_di" bpmnElement="flow_rule_submit">
        <di:waypoint x="800" y="236" />
        <di:waypoint x="960" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_direct_to_gateway1_di" bpmnElement="flow_direct_to_gateway1">
        <di:waypoint x="1060" y="236" />
        <di:waypoint x="1110" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_timeout_to_dept_di" bpmnElement="flow_timeout_to_dept">
        <di:waypoint x="1010" y="158" />
        <di:waypoint x="1010" y="120" />
        <di:waypoint x="1360" y="120" />
        <di:waypoint x="1360" y="196" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_mgr_pass_di" bpmnElement="flow_mgr_pass">
        <di:waypoint x="1160" y="236" />
        <di:waypoint x="1210" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_mgr_reject_di" bpmnElement="flow_mgr_reject">
        <di:waypoint x="1135" y="261" />
        <di:waypoint x="1135" y="520" />
        <di:waypoint x="1575" y="520" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_g1_yes_di" bpmnElement="flow_g1_yes">
        <di:waypoint x="1260" y="236" />
        <di:waypoint x="1310" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_g1_no_di" bpmnElement="flow_g1_no">
        <di:waypoint x="1235" y="261" />
        <di:waypoint x="1235" y="420" />
        <di:waypoint x="1585" y="420" />
        <di:waypoint x="1585" y="261" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_dept_to_gateway2_di" bpmnElement="flow_dept_to_gateway2">
        <di:waypoint x="1410" y="236" />
        <di:waypoint x="1460" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_dept_pass_di" bpmnElement="flow_dept_pass">
        <di:waypoint x="1510" y="236" />
        <di:waypoint x="1560" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_dept_reject_di" bpmnElement="flow_dept_reject">
        <di:waypoint x="1485" y="261" />
        <di:waypoint x="1485" y="470" />
        <di:waypoint x="1600" y="470" />
        <di:waypoint x="1600" y="495" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_g2_yes_di" bpmnElement="flow_g2_yes">
        <di:waypoint x="1610" y="236" />
        <di:waypoint x="1660" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_g2_no_di" bpmnElement="flow_g2_no">
        <di:waypoint x="1585" y="211" />
        <di:waypoint x="1585" y="120" />
        <di:waypoint x="1960" y="120" />
        <di:waypoint x="1960" y="196" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_cfo_to_gate_di" bpmnElement="flow_cfo_to_gate">
        <di:waypoint x="1760" y="236" />
        <di:waypoint x="1810" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_cfo_pass_di" bpmnElement="flow_cfo_pass">
        <di:waypoint x="1860" y="236" />
        <di:waypoint x="1910" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_cfo_reject_di" bpmnElement="flow_cfo_reject">
        <di:waypoint x="1835" y="261" />
        <di:waypoint x="1835" y="520" />
        <di:waypoint x="1625" y="520" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_finance_to_gate_di" bpmnElement="flow_finance_to_gate">
        <di:waypoint x="2010" y="236" />
        <di:waypoint x="2060" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_finance_pass_di" bpmnElement="flow_finance_pass">
        <di:waypoint x="2110" y="236" />
        <di:waypoint x="2160" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_finance_reject_di" bpmnElement="flow_finance_reject">
        <di:waypoint x="2085" y="261" />
        <di:waypoint x="2085" y="570" />
        <di:waypoint x="1600" y="570" />
        <di:waypoint x="1600" y="545" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_rejected_notify_di" bpmnElement="flow_rejected_notify">
        <di:waypoint x="1625" y="520" />
        <di:waypoint x="1700" y="520" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_rejected_end_di" bpmnElement="flow_rejected_end">
        <di:waypoint x="1800" y="520" />
        <di:waypoint x="1850" y="520" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_notify_cashier_di" bpmnElement="flow_notify_cashier">
        <di:waypoint x="2260" y="236" />
        <di:waypoint x="2320" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_cashier_notify_di" bpmnElement="flow_cashier_notify">
        <di:waypoint x="2420" y="236" />
        <di:waypoint x="2770" y="236" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_urge_go_di" bpmnElement="flow_urge_go">
        <di:waypoint x="2370" y="294" />
        <di:waypoint x="2370" y="304" />
        <di:waypoint x="2510" y="304" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_urge_done_di" bpmnElement="flow_urge_done">
        <di:waypoint x="2610" y="304" />
        <di:waypoint x="2660" y="304" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_notify_end_di" bpmnElement="flow_notify_end">
        <di:waypoint x="2870" y="236" />
        <di:waypoint x="2930" y="236" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
```

> **催打与到账的时序**（2026-09-08 修正）：催打不再走并行分支，改为「出纳打款确认」上的**非中断边界定时器**（虚线圆圈，`cancelActivity="false"`）。打款完成 → 任务结束、催打定时器随任务自动取消 → 主路径立即发 `[到账通知]`；到点未打款 → 发一次 `[催打提醒]`、任务保留，主流程继续等打款——到账通知只可能出现在真实打款之后。
>
> **Timer 快速测试**：主管审批挂**中断**边界定时器（`PT4M`，触发即取消主管任务、升级部门经理）；出纳打款挂**非中断**边界定时器（`PT24H`）。要当场验证催打路径，把 `PT24H` 改成 `PT2M` 再发布：孙出纳 2 分钟不打款 → 引擎日志 `[催打提醒]`、待办仍在；打款后立即 `[到账通知]`。若在计时器触发前就打款，则无催打、到账通知立即发出。

***

## 4. DMN XML（审批层级决策表）

保存为 `apps/flowable-engine/src/main/resources/dmn/approvalLevel.dmn`（`dmn` 目录不存在就新建）。引擎**启动时**自动扫描 `classpath*:/dmn/` 部署；**改规则必须重启引擎**。

decision id 是 `approvalLevel`，与 §3 BPMN 里 Service Task（DMN 节点）表达式的 `decisionKey('approvalLevel')` 对应；输出列 name 是 `level`，与网关条件 `${level == ...}` 对应。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             id="approvalLevelDefs"
             name="approvalLevel"
             namespace="http://dsh.ai/dmn">

  <decision id="approvalLevel" name="报销审批层级">
    <decisionTable id="approvalLevelTable" hitPolicy="FIRST">
      <input id="in_amount" label="报销金额">
        <inputExpression id="in_amount_expr" typeRef="number" expressionLanguage="juel">
          <text>amount</text>
        </inputExpression>
      </input>
      <output id="out_level" name="level" label="审批层级" typeRef="string"/>

      <rule id="rule_1">
        <inputEntry id="ie_1_amount"><text>#{amount &gt;= 0 and amount &lt;= 150}</text></inputEntry>
        <outputEntry id="oe_1"><text>"直属主管"</text></outputEntry>
      </rule>
      <rule id="rule_2">
        <inputEntry id="ie_2_amount"><text>#{amount &gt;= 151 and amount &lt;= 250}</text></inputEntry>
        <outputEntry id="oe_2"><text>"直属主管+部门经理"</text></outputEntry>
      </rule>
      <rule id="rule_3">
        <inputEntry id="ie_3_amount"><text>#{amount &gt;= 251 and amount &lt;= 999999}</text></inputEntry>
        <outputEntry id="oe_3"><text>"直属主管+部门经理+费用专员"</text></outputEntry>
      </rule>
      <rule id="rule_catchall">
        <inputEntry id="ie_ca_amount"><text>#{true}</text></inputEntry>
        <outputEntry id="oe_ca"><text>"直属主管+部门经理+费用专员"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>
```

| 测试路径 | 发票合计金额 | 期望 level   | 经过的审批人             |
| ---- | ------ | ---------- | ------------------ |
| 小额   | 150    | 直属主管       | 王主管                |
| 中额   | 250   | 直属+部门经理    | 王主管 → 赵经理          |
| 大额   | >250   | 直属+部门+费用专员 | 王主管 → 赵经理 → 会签 2/3 |

***

## 5. JavaDelegate 完整代码（3 个文件）

复制到 `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/`，然后 `mvn compile` + 重启引擎。

> 本 DEMO 无自动（LLM）节点，3 个 delegate 都是通知类；自动（LLM）节点 = DSH backend task（见 §0.2）。

### 5.1 NotifyPaymentDelegate —— 通知出纳打款

```java
package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 通知出纳打款(演示版:日志代替真实通知渠道)。
 * BPMN: flowable:delegateExpression="${notifyPaymentDelegate}"
 */
@Component("notifyPaymentDelegate")
public class NotifyPaymentDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyPaymentDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        log.info("[打款通知] 请为 {} 打款 {} 元,流程实例 {}",
            applicantName, amount, execution.getProcessInstanceId());
        execution.setVariable("paymentNotified", true);
    }
}
```

### 5.2 NotifyUrgentDelegate —— 24h 超时催打出纳

```java
package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 24h 超时催打出纳(演示版:日志)。
 * BPMN: flowable:delegateExpression="${notifyUrgentDelegate}"
 */
@Component("notifyUrgentDelegate")
public class NotifyUrgentDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyUrgentDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        log.info("[催打提醒] 报销人 {} 的 {} 元报销已超过 24h 未打款,流程实例 {}",
            applicantName, amount, execution.getProcessInstanceId());
        execution.setVariable("urgentNotified", true);
    }
}
```

### 5.3 NotifyEmployeeDelegate —— 通知员工（到账 / 被拒，一个 bean 两用）

BPMN 有两处 Service Task 指向它：`notifyEmployee`（到账通知）与 `notifyRejected`（拒绝通知）。delegate 内部按流程变量区分场景：走到拒绝路径时 `approvalResult` 为 reject 或 `financeVerified` 为 false。

```java
package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 通知员工报销结果(演示版:日志)。
 * BPMN: flowable:delegateExpression="${notifyEmployeeDelegate}"
 * 用于 notifyEmployee(到账) 与 notifyRejected(被拒) 两个节点。
 */
@Component("notifyEmployeeDelegate")
public class NotifyEmployeeDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(NotifyEmployeeDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        String applicantName = (String) execution.getVariable("applicantName");
        Object amount = execution.getVariable("amount");
        boolean rejected = !"approve".equals(execution.getVariable("approvalResult"))
            || !Boolean.TRUE.equals(execution.getVariable("financeVerified"));
        if (rejected) {
            log.info("[拒绝通知] 尊敬的 {},您的 {} 元报销申请未通过审核,流程实例 {}",
                applicantName, amount, execution.getProcessInstanceId());
        } else {
            log.info("[到账通知] 尊敬的 {},您的 {} 元报销已打款,流程实例 {}",
                applicantName, amount, execution.getProcessInstanceId());
        }
        execution.setVariable("employeeNotified", true);
    }
}
```

***

## 6. SKILL.md —— 6 个 Skill

每个 skill 放 `%USERPROFILE%\.dsh\skills\<skill名>\SKILL.md`（目录自己建）。DSH 自动扫描，无需重启。当前用户是谁，DSH 会话就能触发谁的 skill。

### 6.1 报销单自动填写与票据审核（张三用）

**目录**: `%USERPROFILE%\.dsh\skills\expense-form-assistant\SKILL.md`

````markdown
---
name: expense-form-assistant
description: 多张发票图片逐张提取字段、要素审核、算合计，预填报销单表单
triggers:
  - 报销单填写
  - expense form
---

# 报销单自动填写与票据审核助手

## 你要做的事

询问报销事由、提醒用户上传发票文件，把用户提供的信息（多张发票文件 + 报销事由）和当前用户的用户名映射成提交 JSON。JSON 顶层字段：**applicantName**（申请人）、**amount**（合计金额）、**reason**（事由）、**invoiceList**（发票数组，每张含 invoiceNo/amount/issuedOn/expenseType 四字段）、**auditPassed**（审核是否通过）、**auditNotes**（审核说明）。

> 契约：这6个字段名用于输出的JSON格式中，一个都不能少。

## 执行步骤

### Step 1: 解析输入

- 询问报销事由
- 用户上传了几张发票文件 → **逐张**识别，每张提取发票号、金额、开票日期（yyyy-MM-dd）、类型；每张发票各自一条，不能只汇总
- 用户直接说了（如"出差北京 三张发票 688+890+802"）→ 按描述拆成 3 条

### Step 2: 类型映射（逐张做）

- 火车票、飞机票、网约车、地铁 → **交通费**
- 酒店、民宿 → **住宿费**
- 餐饮发票 → **餐饮费**
- 办公用品、设备 → **办公采购**
- 其他 → **其他**

### Step 3: 要素审核（逐张做，结论写 auditPassed/auditNotes）

- 单张金额 > 0 且合计不超过 100000
- 开票日期距今 ≤ 365 天
- 类型映射成功

全部满足 → `auditPassed: true`，auditNotes 写一句通过说明；任一不满足 → `auditPassed: false`，auditNotes 逐条列出问题发票。

如果`auditPassed: false`则停下，持续提醒用户修订提交信息，直到`auditPassed: true`才往下进行

### Step 4: 生成提交 JSON（amount = 发票合计）

```json
{
  "applicantName": "张三",
  "amount": 2380,
  "reason": "北京出差住宿 3 晚",
  "invoiceList": [
    { "invoiceNo": "044031900111", "amount": 688, "issuedOn": "2026-09-01", "expenseType": "住宿费" },
    { "invoiceNo": "044031900112", "amount": 890, "issuedOn": "2026-09-02", "expenseType": "住宿费" },
    { "invoiceNo": "044031900113", "amount": 802, "issuedOn": "2026-09-03", "expenseType": "住宿费" }
  ],
  "auditPassed": true,
  "auditNotes": "3 张发票要素齐全，金额合计 2380 元，审核通过"
}
```

### Step 5: 输出

输出上一步生成的纯JSON文本，不要包含任何其他内容

## 注意

- OCR 置信度低于 80% 的字段标注 ⚠️ 让用户确认
- 不要替用户编"事由"——事由是业务描述，OCR 搞不定
- 同一个任务只跑一次，输出 JSON + 提示就结束
````

### 6.2 直属主管审批助手（王主管用）

**目录**: `%USERPROFILE%\.dsh\skills\direct-manager-approver\SKILL.md`

```markdown
---
name: direct-manager-approver
description: 直属主管审批时的历史对比和建议生成
triggers:
  - 报销审批
  - approve expense
---

# 直属主管审批助手

## 你要做的事

判断提交的报销单**要不要过**。

## 执行步骤

### Step 1: 查历史对比

近 90 天同类型报销对比表（没有真实数据就标注"模拟估算"）：

| 指标 | 部门均值 | 差异 |
|---|---|---|
| 近 90 天同类型笔数 | 2 | +20% |
| 近 90 天同类型总额 | ¥2,100 | +36% |

### Step 2: 生成三档建议

- ✅ **建议通过**：金额合理，频率正常
- ⚠️ **建议关注**：高于部门均值 50% 或每月同类超 4 次
- ❌ **建议驳回**：超过均值 2 倍或异常高频

附一段可直接用的审批意见草稿：

> "张三近 90 天出差住宿共 3 笔 ¥2,850，部门均值 ¥2,100。本次 ¥2,380 略高于均值但在合理区间。**建议通过**。"

### Step 3: 提示提交格式

> 确认后请让会话输出纯JSON `{"approvalResult": "approve/reject", "approvalComment": "<意见>"}`。
```

### 6.3 部门经理审批助手（赵经理用）

**目录**: `%USERPROFILE%\.dsh\skills\dept-manager-approver\SKILL.md`

```markdown
---
name: dept-manager-approver
description: 部门经理审批时的预算和合规检查
triggers:
  - 部门经理审批
---

# 部门经理审批助手

## 你要做的事

重点检查**预算使用率**和报销单的**合规性**。

## 执行步骤

### Step 1: 预算核查

> **本季度差旅预算**: ¥50,000
> **已审批**: ¥32,800

### Step 2: 合规检查

- 单次金额是否超部门标准（默认 ¥3,000）
- 不要超出季度预算

### Step 4: 输出建议 + 提交格式

三档建议（✅/⚠️/❌）+ 意见草稿，确认后输出纯JSON `{"approvalResult": "approve/reject", "approvalComment": "<意见>"}`。
```

### 6.4 费用专员终审助手（陈/孙/周专员用，会签）

**目录**: `%USERPROFILE%\.dsh\skills\cfo-final-approver\SKILL.md`

```markdown
---
name: cfo-final-approver
description: 大额报销终审时的全链路风险评估（会签场景）
triggers:
  - 费用专员终审
  - 大额终审
---

# 费用专员终审助手

## 你要做的事

大额报销终审，重点检查**大额专项**和**整体预算**。

## 执行步骤

### Step 1: 大额专项检查

- 是否超公司单次差旅标准（¥5,000 触发终审）——按总金额判断
- 发票清单完整性（指令中给出的清单：张数、类型、单张金额）

### Step 2: 预算总览

> 公司本季度差旅预算 ¥500,000，已审批 68%。

### Step 3: 表决建议 + 提交格式

> 建议：✅ 我同意通过 / ❌ 我建议驳回 + 理由。
> 确认后输出纯JSON `{"approvalResult": "approve/reject", "approvalComment": "<理由>"}`。

```

### 6.5 发票勾稽校验助手（钱财务用）

**目录**: `%USERPROFILE%\.dsh\skills\invoice-verifier\SKILL.md`

```markdown
---
name: invoice-verifier
description: 财务专员审核票据的勾稽校验
triggers:
  - 票据审核
  - 发票勾稽校验
---

# 发票勾稽校验助手

## 你要做的事

验证发票的勾稽校验。

## 执行步骤

### Step 1: 勾稽校验

| 检查项 | 规则 |
|---|---|
| 金额勾稽 | 单张金额之和 = 任务指令中给出的合计金额 |
| 单张金额 | 每张 > 0 |
| 开票日期 | 距今 ≤ 365 天（与提交时 AI 预审同口径） |
| 发票号 | 非空、无重复 |
| 类型 | 与事由匹配（住宿事由出现餐饮票要说明） |

### Step 2: 输出提交 JSON

{
  "financeVerified": true/false,
  "financeNotes": "发票要素齐全，金额等式校验通过，验真未发现异常"
}

```

### 6.6 出纳对账助手（孙出纳用）

**目录**: `%USERPROFILE%\.dsh\skills\cashier-payment\SKILL.md`

```markdown
---
name: cashier-payment
description: 出纳执行报销打款时的银行对账辅助
triggers:
  - 出纳打款
  - 打款确认
---

# 出纳对账助手

## 你要做的事

生成网银指令、检查借支。

## 执行步骤

### Step 1: 展示打款信息卡

收款人: 报销申请人
打款金额: 报销总金额
打款事由: 报销事由

### Step 2: 检查借支

模拟：该申请人有/无未结清借支；有则先冲销。

### Step 3: 生成网银指令并确认

模拟：生成网银指令并展示，询问确认。直到得到确认再往下走。

### Step 4: 输出纯JSON

{
  "paymentConfirmed": "true/false",
  "transactionId": "20260905-0001"
}

## 注意

- transactionId模拟，别编真号
```

***

## 7. 分步操作手册（从零到跑通）

### 阶段一：准备文件（做一次）

1. **复制 DMN**：§4 XML → `apps/flowable-engine/src/main/resources/dmn/approvalLevel.dmn`
2. **复制 Java**：§5 的 3 个文件 → `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/`
3. **编译**：
   ```powershell
   cd d:\works\deepseek-harness\apps\flowable-engine
   mvn compile -q
   ```

### 阶段二：启动服务

1. **终端 A** 启动引擎（`.\.env.ps1` + `mvn spring-boot:run`），启动日志里确认 DMN 部署（搜 `approvalLevel`）
2. **终端 B1** 启动 Web Console 后端（`.\.env.ps1` + `mvn spring-boot:run`）
3. **终端 B2** 启动 Web Console 前端（`pnpm dev`），浏览器开 <http://localhost:5173>

### 阶段三：建用户和角色（Web Console + Supabase Dashboard）

1. **创建 8 个 Supabase Auth 用户**：Supabase Dashboard → Authentication → Users → Add user，逐个创建（邮箱密码随意，如 `zhangsan@dsh.local` / `Passw0rd!`）。注册 trigger 自动在 `platform_users` 插入 `pending_approval` 行
2. **激活用户**：Web Console → 用户管理 → 把 8 个用户逐个审批为 `active`（第一个管理员账号如果还没有，按 setup guide §8.4 用 SQL 引导一个 `system_admin`）
3. **建应用**：应用页 → 创建（如"财务共享中心"），状态直接 active
4. **建 6 个角色**：应用详情 → 角色页，按 §0.1 表格建（部门经理、费用专员**不选父角色**）
5. **加角色成员**（关键！不加成员 = 任务无人可见）：每个角色 → 成员管理 → 添加对应用户。引擎的候选人就是从这里查的（`app_memberships`）

### 阶段四：建流程并发布

1. **复制角色 UUID**：角色页逐个复制 6 个 UUID
2. **粘贴 BPMN**：应用详情 → 新建流程 → XML 视图 → 粘贴 §3 XML（先做 6 个占位符全局替换）→ 保存草稿
3. **检查画布**：切回图形视图应看到完整流程图（18 个任务/网关节点 + 4 个事件节点 + 2 个边界定时器，共 27 条连线）；点几个节点核对属性面板里的角色引用
4. **校验 + 发布**：点校验（角色引用、多实例、条件表达式、initiator 声明结构都会查）→ 发布。发布后记下流程定义

### 阶段五：启动实例、跑流程

1. **启动 DSH 员工端**：终端 C 按 §1.3（3 个环境变量 + `pnpm dsh --profile enterprise`），登录张三账号
2. **启动流程实例**：**这一步在 Web Console**（V1 由管理员代启动）——实例页 → 启动实例 → 选刚发布的流程 → 变量可不填 → 确认。系统自动注入 `initiator`（按当前登录管理员；员工端自助发起上线后即为申请人本人），第一个待办"员工提交报销单"进入报销人角色候选
3. **张三提交**：DSH 员工端待办列表 → 打开"员工提交报销单" → 上传多张发票图片（或说"出差北京 3 晚住宿 688+890+802"）→ skill 逐张提取发票信息、审核要素、算好合计生成 JSON → 核对发票清单与审核结论 → 提交
4. **依次推进**（每步都是：DSH 退出登录 → 登下一个用户 → 处理待办）：
   | 步骤 | 登录  | 待办                 | skill                   |
   | -- | --- | ------------------ | ----------------------- |
   | 1  | 张三  | 员工提交报销单            | expense-form-assistant  |
   | 2  | 王主管 | 直属主管审批             | direct-manager-approver |
   | 3  | 赵经理 | 部门经理审批（中额起）        | dept-manager-approver   |
   | 4  | 陈专员 | 费用专员终审（大额起）        | cfo-final-approver      |
   | 5  | 孙专员 | 费用专员终审（第 2 份，会签达成） | cfo-final-approver      |
   | 6  | 钱财务 | 财务专员票据审核           | invoice-verifier        |
   | 7  | 孙出纳 | 出纳打款确认             | cashier-payment         |
5. **验证自动化节点**：引擎终端 A 的日志应依次出现 `[打款通知]`、`[到账通知]`（PT2M 测试版且出纳未在 2 分钟内打款时，打款前还会出现一次 `[催打提醒]`）；Web Console 实例详情页可看变量终值（invoiceList、amount、auditNotes、level、approvalComment、transactionId...）和活动路径图

### 阶段六（可选）：守卫与超时路径验证

1. **超时升级**：Timer 改 PT2M 发布新版本 → 启动实例 → 王主管 2 分钟不处理 → 引擎日志无感、实例详情里主管任务被取消、赵经理收到升级待办
2. **催打不中断**：出纳打款确认的边界定时器改 PT2M → 启动实例 → 孙出纳 2 分钟不打款 → 引擎日志 `[催打提醒]`、任务仍留在待办列表（非中断），之后照常打款 → `[到账通知]`；若在计时器触发前就打款，则无催打、到账通知立即发出
3. **状态守卫**（实例运行中时）：
   - 停用该流程 → 应报"存在运行中实例"
   - 归档应用 → 应报"存在未归档流程"
   - 停用王主管（用户管理）→ 应报"名下尚有未完成任务"
   - 停用直属主管角色 → 应报"被运行中实例使用"