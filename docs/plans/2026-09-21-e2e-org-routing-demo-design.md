# 端到端 DEMO

## 1. 场景与布景设计

### 1.1 组织树（org\_units）

```
总公司(负责人:马总)
├── 华东区(负责人:老周)
│   ├── A 部门(负责人:张三)
│   └── B 部门(负责人:李四)
└── 财务部(负责人:钱姐)
```

### 1.2 用户与归属（8 个 Supabase Auth 账号）

| 账号     | 部门归属（org\_unit\_members） | 角色成员（应用内角色） |
| ------ | ------------------------ | ----------- |
| 马总     | 总公司                      | —           |
| 老周     | 华东区                      | 审批专员        |
| 张三     | A 部门                     | —           |
| 李四     | B 部门                     | —           |
| 小王     | A 部门                     | —           |
| **小陈** | **A 部门 + B 部门（多对多核心）**   | 审批专员、出纳     |
| 钱姐     | 财务部                      | 财务复核员       |
| 小钱     | 财务部                      | 财务复核员       |

### 1.4 UUID 占位符（8 个 + profile 地址）

复制 XML 前全局替换：

| 占位符                 | 替换为                                                |
| ------------------- | -------------------------------------------------- |
| `ORG_HEAD_UUID`     | 总公司部门 id                                           |
| `ORG_EAST_UUID`     | 华东区部门 id                                           |
| `ORG_A_UUID`        | A 部门部门 id                                          |
| `ORG_B_UUID`        | B 部门部门 id                                          |
| `ORG_FINANCE_UUID`  | 财务部部门 id                                           |
| `ROLE_SPECIAL_UUID` | 审批专员角色 id                                          |
| `ROLE_FINANCE_UUID` | 财务复核员角色 id                                         |
| `ROLE_CASHIER_UUID` | 出纳角色 id                                            |
| `PROFILE_URL_N`     | backend profile 实例地址（P2，如 `http://127.0.0.1:3081`） |

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
        <dsh:contextVariable name="expenseId" type="string" description="SOR 报销单 id(启动参数,提报 skill 建单后传入)" source="start-param" />
        <dsh:contextVariable name="expenseStatus" type="string" description="单据当前状态(读取报销单节点从 SOR 写入:opened/ongoing/approved/rejected/paid/cancelled)" />
        <dsh:contextVariable name="expenseTitle" type="string" description="报销单标题(读取报销单节点从 SOR 写入)" />
        <dsh:contextVariable name="reason" type="string" description="报销事由(读取报销单节点从 SOR 写入)" />
        <dsh:contextVariable name="amount" type="float" description="报销总金额(读取报销单节点从 SOR 写入,DMN 输入)" />
        <dsh:contextVariable name="itemList" type="array" description="发票明细(读取报销单节点从 SOR 写入,逐张复核集合)" itemType="object">
          <dsh:field name="expenseType" type="string" description="费用类别" />
          <dsh:field name="amount" type="float" description="单张金额" />
          <dsh:field name="issuedOn" type="date" description="发生日期" />
          <dsh:field name="description" type="string" description="说明" />
        </dsh:contextVariable>
        <dsh:contextVariable name="itemCount" type="integer" description="明细行数(读取报销单节点写入)" />
        <dsh:contextVariable name="summary" type="string" description="报销摘要(Script Task 生成)" />
        <dsh:contextVariable name="level" type="string" description="审批专线(DMN 产出)" />
        <dsh:contextVariable name="approvalResult" type="string" description="审批结论(approve/reject)" />
        <dsh:contextVariable name="approvalComment" type="string" description="审批意见" />
        <dsh:contextVariable name="approvalApproverId" type="string" description="审批人 user.id(审批节点输出映射写入,登记 SOR 用)" />
        <dsh:contextVariable name="approvalApproverName" type="string" description="审批人显示名(审批节点输出映射写入,登记 SOR 用)" />
        <dsh:contextVariable name="financeVerified" type="boolean" description="验票是否通过" />
        <dsh:contextVariable name="financeNotes" type="string" description="验票说明" />
        <dsh:contextVariable name="paymentConfirmed" type="boolean" description="打款是否完成" />
        <dsh:contextVariable name="transactionId" type="string" description="打款流水号" />
      </dsh:contextVariables>
    </bpmn2:extensionElements>
    <bpmn2:startEvent id="startEvent" name="开始" />
    <bpmn2:sequenceFlow id="flow01" sourceRef="startEvent" targetRef="fetchExpense" />
    <bpmn2:serviceTask id="fetchExpense" name="读取报销单" flowable:async="true" flowable:delegateExpression="${sorExpenseDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT1M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow02" sourceRef="fetchExpense" targetRef="buildSummary" />
    <bpmn2:scriptTask id="buildSummary" name="生成报销摘要" scriptFormat="juel">
      <bpmn2:script>${execution.setVariable('summary', '报销事由：'.concat(reason == null ? '' : reason).concat('；合计 ').concat(amount == null ? '0' : amount.toString()).concat(' 元，共 ').concat(itemCount == null ? '0' : itemCount.toString()).concat(' 张发票'))}</bpmn2:script>
    </bpmn2:scriptTask>
    <bpmn2:sequenceFlow id="flow03" sourceRef="buildSummary" targetRef="decideLevel" />
    <bpmn2:serviceTask id="decideLevel" name="DMN:决定审批专线" flowable:expression="${execution.setVariables(dmnRuleService.createExecuteDecisionBuilder().decisionKey(&#39;orgRoutingLevel&#39;).variables(execution.getVariables()).executeWithSingleResult())}" />
    <bpmn2:sequenceFlow id="flow04" sourceRef="decideLevel" targetRef="auditInvoices" />
    <bpmn2:serviceTask id="auditInvoices" name="逐张发票复核" flowable:delegateExpression="${invoiceAuditDelegate}">
      <bpmn2:multiInstanceLoopCharacteristics flowable:collection="itemList" flowable:elementVariable="item" />
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow05" sourceRef="auditInvoices" targetRef="directManagerApprove" />
    <bpmn2:userTask id="directManagerApprove" name="直属审批">
      <bpmn2:extensionElements>
        <dsh:assignmentRule virtualRole="parent" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:skillRef>expense-lookup</dsh:skillRef>
        <dsh:userPrompt text="请审批 {{initiator.name}} 的报销单（单号 {{expenseId}}）：{{summary}}。可调用 expense-lookup skill 查看原始单据明细。调用 universal-approver skill 核对合理性，输出包含 approvalResult（approve/reject）、approvalComment、approverId（你的用户id）、approverName（你的显示名）的纯JSON。&#10;&#10;输出格式，不需要包含其他任何信息&#10;请以以下的JSON格式进行输出:&#10;{&#10;  &#34;approvalResult&#34;: &#34;&#34;,&#10;  &#34;approvalComment&#34;: &#34;&#34;,&#10;  &#34;approverId&#34;: &#34;&#34;,&#10;  &#34;approverName&#34;: &#34;&#34;&#10;}" />
        <dsh:actionPolicy>
          <dsh:timeoutPolicy duration="PT2M" escalateToVirtualRole="parent" />
        </dsh:actionPolicy>
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
          <dsh:mapping source="approverId" target="approvalApproverId" />
          <dsh:mapping source="approverName" target="approvalApproverName" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow06" sourceRef="directManagerApprove" targetRef="recordDirectApproval" />
    <bpmn2:serviceTask id="recordDirectApproval" name="登记直属审批" flowable:async="true" flowable:delegateExpression="${sorApprovalDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT1M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow06b" sourceRef="recordDirectApproval" targetRef="gatewayMgrOutcome" />
    <bpmn2:exclusiveGateway id="gatewayMgrOutcome" name="直属通过?" />
    <bpmn2:sequenceFlow id="flow07" sourceRef="gatewayMgrOutcome" targetRef="gatewayNeedSpecial">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow08" sourceRef="gatewayMgrOutcome" targetRef="notifyRejected">
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
        <dsh:assignmentRule candidateRoleId="626cbcb6-60c3-4bec-bcca-2b7f35595446" orgScope="sameLine" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:skillRef>expense-lookup</dsh:skillRef>
        <dsh:userPrompt text="请进行专线合规审批（单号 {{expenseId}}）：{{summary}}。可调用 expense-lookup skill 查看原始单据明细。调用 universal-approver skill 核对合规性，输出包含 approvalResult（approve/reject）、approvalComment、approverId（你的用户id）、approverName（你的显示名）的纯JSON。&#10;&#10;请以以下的JSON格式进行输出:&#10;{&#10;  &#34;approvalResult&#34;: &#34;&#34;,&#10;  &#34;approvalComment&#34;: &#34;&#34;,&#10;  &#34;approverId&#34;: &#34;&#34;,&#10;  &#34;approverName&#34;: &#34;&#34;&#10;}" />
        <dsh:outputMappings>
          <dsh:mapping source="approvalResult" target="approvalResult" />
          <dsh:mapping source="approvalComment" target="approvalComment" />
          <dsh:mapping source="approverId" target="approvalApproverId" />
          <dsh:mapping source="approverName" target="approvalApproverName" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow11" sourceRef="specialLineApprove" targetRef="recordSpecialApproval" />
    <bpmn2:serviceTask id="recordSpecialApproval" name="登记专线审批" flowable:async="true" flowable:delegateExpression="${sorApprovalDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT1M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow11b" sourceRef="recordSpecialApproval" targetRef="gatewaySpecialOutcome" />
    <bpmn2:exclusiveGateway id="gatewaySpecialOutcome" name="专线通过?" />
    <bpmn2:sequenceFlow id="flow12" sourceRef="gatewaySpecialOutcome" targetRef="financeVerify">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult == 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow13" sourceRef="gatewaySpecialOutcome" targetRef="notifyRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${approvalResult != 'approve'}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:userTask id="financeVerify" name="财务复核">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="363a52f6-45d8-49cf-9f7d-998af47c4ae4" orgScope="fixedUnit" fixedUnitId="e1208f08-107f-4895-8890-38ef363cb684" />
        <dsh:skillRef>universal-approver</dsh:skillRef>
        <dsh:skillRef>expense-lookup</dsh:skillRef>
        <dsh:userPrompt text="请验票（单号 {{expenseId}}）：明细合计 {{amount}} 元。可调用 expense-lookup skill 逐张核对原始单据与附件。调用 universal-approver skill 核对要素与勾稽，输出包含 financeVerified（true/false）、financeNotes、approverId（你的用户id）、approverName（你的显示名）的纯JSON。&#10;&#10;请以以下的JSON格式进行输出:&#10;{&#10;  &#34;financeVerified&#34;: &#34;false&#34;,&#10;  &#34;financeNotes&#34;: &#34;&#34;,&#10;  &#34;approverId&#34;: &#34;&#34;,&#10;  &#34;approverName&#34;: &#34;&#34;&#10;}" />
        <dsh:outputMappings>
          <dsh:mapping source="financeVerified" target="financeVerified" />
          <dsh:mapping source="financeNotes" target="financeNotes" />
          <dsh:mapping source="approverId" target="approvalApproverId" />
          <dsh:mapping source="approverName" target="approvalApproverName" />
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
    <bpmn2:sequenceFlow id="flow14" sourceRef="financeVerify" targetRef="recordFinanceVerify" />
    <bpmn2:serviceTask id="recordFinanceVerify" name="登记财务复核" flowable:async="true" flowable:delegateExpression="${sorApprovalDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT1M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow14b" sourceRef="recordFinanceVerify" targetRef="gatewayFinOutcome" />
    <bpmn2:exclusiveGateway id="gatewayFinOutcome" name="验票通过?" />
    <bpmn2:sequenceFlow id="flow15" sourceRef="gatewayFinOutcome" targetRef="cashierConfirm">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="flow16" sourceRef="gatewayFinOutcome" targetRef="notifyRejected">
      <bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">${!financeVerified}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:serviceTask id="urgeFinance" name="自动催办复核" flowable:delegateExpression="${logDelegate}" />
    <bpmn2:sequenceFlow id="flow17" sourceRef="boundaryUrgeFinance" targetRef="urgeFinance" />
    <bpmn2:endEvent id="endUrged" name="已催办" />
    <bpmn2:sequenceFlow id="flow18" sourceRef="urgeFinance" targetRef="endUrged" />
    <bpmn2:userTask id="cashierConfirm" name="出纳打款确认">
      <bpmn2:extensionElements>
        <dsh:assignmentRule candidateRoleId="54287b50-0134-4bd0-b9ee-f8e95e351d30" />
        <dsh:userPrompt text="请执行打款确认（单号 {{expenseId}}）：收款人 {{initiator.name}}，金额 {{amount}} 元。单据当前状态为 {{expenseStatus}}（只有 approved 即已正式批准才能打款）。可调用 expense-lookup skill 核对明细与审批记录；状态不是 approved 则拒绝打款。输出包含 paymentConfirmed（true）、transactionId（打款流水号，可以虚构）、approverId（你的用户id）、approverName（你的显示名）的纯JSON。&#10;&#10;请以以下的JSON格式进行输出:&#10;{&#10;  &#34;paymentConfirmed&#34;: &#34;false&#34;,&#10;  &#34;transactionId&#34;: &#34;&#34;,&#10;  &#34;approverId&#34;: &#34;&#34;,&#10;  &#34;approverName&#34;: &#34;&#34;&#10;}" />
        <dsh:actionPolicy>
          <dsh:timeoutPolicy duration="PT2M" escalateToVirtualRole="parent" />
        </dsh:actionPolicy>
        <dsh:skillRef>expense-lookup</dsh:skillRef>
        <dsh:outputMappings>
          <dsh:mapping source="paymentConfirmed" target="paymentConfirmed" />
          <dsh:mapping source="transactionId" target="transactionId" />
          <dsh:mapping source="approverId" target="approvalApproverId" />
          <dsh:mapping source="approverName" target="approvalApproverName" />
        </dsh:outputMappings>
      </bpmn2:extensionElements>
      <bpmn2:multiInstanceLoopCharacteristics>
        <bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression">${nrOfCompletedInstances &gt;= 1}</bpmn2:completionCondition>
      </bpmn2:multiInstanceLoopCharacteristics>
    </bpmn2:userTask>
    <bpmn2:sequenceFlow id="flow19" sourceRef="cashierConfirm" targetRef="recordPayment" />
    <bpmn2:serviceTask id="recordPayment" name="登记打款" flowable:async="true" flowable:delegateExpression="${sorPaymentDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT1M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow19b" sourceRef="recordPayment" targetRef="notifyPayment" />
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
    <bpmn2:serviceTask id="notifyRejected" name="通知报销被拒" flowable:async="true" flowable:delegateExpression="${logDelegate}">
      <bpmn2:extensionElements>
        <flowable:failedJobRetryTimeCycle>R3/PT5M</flowable:failedJobRetryTimeCycle>
      </bpmn2:extensionElements>
      <bpmn2:incoming>flow08</bpmn2:incoming>
      <bpmn2:incoming>flow13</bpmn2:incoming>
      <bpmn2:incoming>flow16</bpmn2:incoming>
    </bpmn2:serviceTask>
    <bpmn2:sequenceFlow id="flow27" sourceRef="notifyRejected" targetRef="endRejected" />
    <bpmn2:endEvent id="endRejected" name="报销被拒" />
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="expenseOrgRouting">
      <bpmndi:BPMNShape id="startEvent_di" bpmnElement="startEvent">
        <dc:Bounds x="150" y="238" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="fetchExpense_di" bpmnElement="fetchExpense">
        <dc:Bounds x="236" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="buildSummary_di" bpmnElement="buildSummary">
        <dc:Bounds x="386" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="decideLevel_di" bpmnElement="decideLevel">
        <dc:Bounds x="536" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="auditInvoices_di" bpmnElement="auditInvoices">
        <dc:Bounds x="686" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="directManagerApprove_di" bpmnElement="directManagerApprove">
        <dc:Bounds x="836" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="recordDirectApproval_di" bpmnElement="recordDirectApproval">
        <dc:Bounds x="986" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayMgrOutcome_di" bpmnElement="gatewayMgrOutcome" isMarkerVisible="true">
        <dc:Bounds x="1126" y="231" width="50" height="50" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="1125" y="207" width="51" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayNeedSpecial_di" bpmnElement="gatewayNeedSpecial" isMarkerVisible="true">
        <dc:Bounds x="1216" y="231" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="specialLineApprove_di" bpmnElement="specialLineApprove">
        <dc:Bounds x="1306" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="recordSpecialApproval_di" bpmnElement="recordSpecialApproval">
        <dc:Bounds x="1456" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewaySpecialOutcome_di" bpmnElement="gatewaySpecialOutcome" isMarkerVisible="true">
        <dc:Bounds x="1596" y="231" width="50" height="50" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="1595" y="207" width="51" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="financeVerify_di" bpmnElement="financeVerify">
        <dc:Bounds x="1686" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="recordFinanceVerify_di" bpmnElement="recordFinanceVerify">
        <dc:Bounds x="1836" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayFinOutcome_di" bpmnElement="gatewayFinOutcome" isMarkerVisible="true">
        <dc:Bounds x="1976" y="231" width="50" height="50" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="1975" y="207" width="51" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="urgeFinance_di" bpmnElement="urgeFinance">
        <dc:Bounds x="1650" y="380" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endUrged_di" bpmnElement="endUrged">
        <dc:Bounds x="1790" y="402" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="cashierConfirm_di" bpmnElement="cashierConfirm">
        <dc:Bounds x="2066" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="recordPayment_di" bpmnElement="recordPayment">
        <dc:Bounds x="2216" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyPayment_di" bpmnElement="notifyPayment">
        <dc:Bounds x="2366" y="216" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewaySplit_di" bpmnElement="gatewaySplit" isMarkerVisible="true">
        <dc:Bounds x="2506" y="231" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="archive_di" bpmnElement="archive">
        <dc:Bounds x="2606" y="120" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyDone_di" bpmnElement="notifyDone">
        <dc:Bounds x="2606" y="310" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gatewayJoin_di" bpmnElement="gatewayJoin" isMarkerVisible="true">
        <dc:Bounds x="2756" y="231" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endEvent_di" bpmnElement="endEvent">
        <dc:Bounds x="2846" y="238" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notifyRejected_di" bpmnElement="notifyRejected">
        <dc:Bounds x="1400" y="460" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endRejected_di" bpmnElement="endRejected">
        <dc:Bounds x="1560" y="482" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="1556" y="518" width="45" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="boundaryUrgeFinance_di" bpmnElement="boundaryUrgeFinance">
        <dc:Bounds x="1718" y="272" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow01_di" bpmnElement="flow01">
        <di:waypoint x="186" y="256" />
        <di:waypoint x="236" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow02_di" bpmnElement="flow02">
        <di:waypoint x="336" y="256" />
        <di:waypoint x="386" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow03_di" bpmnElement="flow03">
        <di:waypoint x="486" y="256" />
        <di:waypoint x="536" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow04_di" bpmnElement="flow04">
        <di:waypoint x="636" y="256" />
        <di:waypoint x="686" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow05_di" bpmnElement="flow05">
        <di:waypoint x="786" y="256" />
        <di:waypoint x="836" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow06_di" bpmnElement="flow06">
        <di:waypoint x="936" y="256" />
        <di:waypoint x="986" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow06b_di" bpmnElement="flow06b">
        <di:waypoint x="1086" y="256" />
        <di:waypoint x="1126" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow07_di" bpmnElement="flow07">
        <di:waypoint x="1176" y="256" />
        <di:waypoint x="1216" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow08_di" bpmnElement="flow08">
        <di:waypoint x="1151" y="281" />
        <di:waypoint x="1151" y="500" />
        <di:waypoint x="1400" y="500" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow09_di" bpmnElement="flow09">
        <di:waypoint x="1266" y="256" />
        <di:waypoint x="1306" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow10_di" bpmnElement="flow10">
        <di:waypoint x="1241" y="231" />
        <di:waypoint x="1241" y="130" />
        <di:waypoint x="1736" y="130" />
        <di:waypoint x="1736" y="216" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow11_di" bpmnElement="flow11">
        <di:waypoint x="1406" y="256" />
        <di:waypoint x="1456" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow11b_di" bpmnElement="flow11b">
        <di:waypoint x="1556" y="256" />
        <di:waypoint x="1596" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow12_di" bpmnElement="flow12">
        <di:waypoint x="1646" y="256" />
        <di:waypoint x="1686" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow13_di" bpmnElement="flow13">
        <di:waypoint x="1621" y="281" />
        <di:waypoint x="1621" y="410" />
        <di:waypoint x="1450" y="410" />
        <di:waypoint x="1450" y="460" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow14_di" bpmnElement="flow14">
        <di:waypoint x="1786" y="256" />
        <di:waypoint x="1836" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow14b_di" bpmnElement="flow14b">
        <di:waypoint x="1936" y="256" />
        <di:waypoint x="1976" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow15_di" bpmnElement="flow15">
        <di:waypoint x="2026" y="256" />
        <di:waypoint x="2066" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow16_di" bpmnElement="flow16">
        <di:waypoint x="2001" y="281" />
        <di:waypoint x="2001" y="640" />
        <di:waypoint x="1450" y="540" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow17_di" bpmnElement="flow17">
        <di:waypoint x="1736" y="308" />
        <di:waypoint x="1736" y="344" />
        <di:waypoint x="1710" y="344" />
        <di:waypoint x="1710" y="380" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow18_di" bpmnElement="flow18">
        <di:waypoint x="1750" y="420" />
        <di:waypoint x="1790" y="420" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow19_di" bpmnElement="flow19">
        <di:waypoint x="2166" y="256" />
        <di:waypoint x="2216" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow19b_di" bpmnElement="flow19b">
        <di:waypoint x="2316" y="256" />
        <di:waypoint x="2366" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow20_di" bpmnElement="flow20">
        <di:waypoint x="2466" y="256" />
        <di:waypoint x="2506" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow21_di" bpmnElement="flow21">
        <di:waypoint x="2531" y="231" />
        <di:waypoint x="2531" y="160" />
        <di:waypoint x="2606" y="160" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow22_di" bpmnElement="flow22">
        <di:waypoint x="2531" y="281" />
        <di:waypoint x="2531" y="350" />
        <di:waypoint x="2606" y="350" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow23_di" bpmnElement="flow23">
        <di:waypoint x="2706" y="160" />
        <di:waypoint x="2781" y="160" />
        <di:waypoint x="2781" y="231" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow24_di" bpmnElement="flow24">
        <di:waypoint x="2706" y="350" />
        <di:waypoint x="2781" y="350" />
        <di:waypoint x="2781" y="281" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow25_di" bpmnElement="flow25">
        <di:waypoint x="2806" y="256" />
        <di:waypoint x="2846" y="256" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow27_di" bpmnElement="flow27">
        <di:waypoint x="1500" y="500" />
        <di:waypoint x="1560" y="500" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
```

## 5. P2 BPMN XML：发文审批（三策略三个定义）

三个流程定义**只有「下级负责人会签」节点不同**（下表），其余 XML 完全一致。发布三次（每次改 process id/name 与会签节点配置）：

| 定义 | process id                  | 会签节点 multiInstanceLoopCharacteristics         |
| -- | --------------------------- | --------------------------------------------- |
| 单签 | `documentReviewSingle`      | 并行 + 完成条件 `${nrOfCompletedInstances &gt;= 1}` |
| 会签 | `documentReviewCountersign` | 并行 + 完成条件留空                                   |
| 串签 | `documentReviewSequential`  | **串行**（`isSequential="true"`）+ 完成条件留空         |

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
>
> - **title/content 声明为** **`source="start-param"`**：启动必须传入，未传报错；员工端 `dsh_process_start_form` 会读出这两个声明供 AI 收集——这是阶段 7 发起链路的直接验证点。P1 无 start-param 声明，start-form 为空、可直接发起，两相对照。
> - **多 AI 合规评审**：2 个 profile 行（`PROFILE_URL_1/2`，可同值）+ `votingRule passCount="1"`（1 票通过即提前收，第 2 实例自动跳过）。若想看"两票全投"，把 passCount 改 2。
> - **下级负责人会签**（虚拟 `child`）：马总（总公司）发起 → 直接下级华东区+财务部的负责人（老周、钱姐）各一条待办。引擎部署时自动补 collection/assignee，无需手写。
> - backend task 失败语义：HTTP/超时/JSON 不合法 → async Job 按 `R3/PT1M` 重试 → 耗尽走失败路径（引擎日志可见，实例可终止重发）。

## 6. DMN XML（审批专线决策表）

保存为 `apps/flowable-engine/src/main/resources/dmn/orgRoutingLevel.dmn`。decision id 是 `orgRoutingLevel`，与 P1 中 ServiceTask 表达式 `decisionKey('orgRoutingLevel')` 对应。输入金额来自流程变量 `amount`——由主轴第一个节点**读取报销单**（`${sorExpenseDelegate}`）从 SOR 单据写入，而非启动参数（启动参数只有 `expenseId`）。

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

| 测试路径 | 金额    | 期望 level  | 走到的节点                       |
| ---- | ----- | --------- | --------------------------- |
| 小额   | 500   | 直属主管      | 直属审批 → 财务复核 → 出纳            |
| 大额   | ≥1000 | 直属主管+专线合规 | 直属审批 → **专线审批** → 财务复核 → 出纳 |

## 7. JavaDelegate 完整代码（5 个文件）

复制到 `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/custom`，然后 `mvn compile` + 重启引擎。其中 7.3/7.4/7.5 三个 delegate 调 SOR，读 Spring 配置 `sor.base-url` / `sor.service-key`——在 `apps/flowable-engine/src/main/resources/application.yml` 追加（环境变量缺失时用 demo 默认值）：

```yaml
sor:
  base-url: ${SOR_BASE_URL:http://127.0.0.1:8091}
  service-key: ${SOR_SERVICE_KEY:demo-service-key}
```

### 7.1 InvoiceAuditDelegate —— 逐张发票复核（多实例元素注入）

```java
package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

/**
 * 逐张发票复核(演示版:日志代替 OCR 校验)。
 * BPMN: flowable:delegateExpression="${invoiceAuditDelegate}"
 * 多实例集合形式: flowable:collection="itemList" flowable:elementVariable="item"
 * 每个实例的 item 就是当前这张发票明细(Map),字段见 P1 上下文变量 itemList 声明。
 */
@Component("invoiceAuditDelegate")
public class InvoiceAuditDelegate implements JavaDelegate {

    @Override
    @SuppressWarnings("unchecked")
    public void execute(DelegateExecution execution) {
        Map<String, Object> item = (Map<String, Object>) execution.getVariable("item");
        ProcessLog.log(execution, "发票复核 第 {} 张: 类别={}, 金额={}, 日期={}, 说明={}",
            execution.getVariable("loopCounter"),
            item.get("expenseType"), item.get("amount"), item.get("issuedOn"), item.get("description"));
        execution.setVariable("lastAuditedItem", String.valueOf(item.get("description")));
    }
}
```

### 7.2 LogDelegate —— 通用通知/归档（一个 bean 多处复用）

```java
package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

/**
 * 通用日志通知(演示版:所有通知/归档节点共用,按当前活动 id 区分场景)。
 * BPMN: flowable:delegateExpression="${logDelegate}"
 * 用于 notifyPayment/notifyDone/archive/urgeFinance/notifyRejected(P1)
 * 与 archive/notifyDone/notifyRejected(P2)。
 */
@Component("logDelegate")
public class LogDelegate implements JavaDelegate {

    @Override
    public void execute(DelegateExecution execution) {
        Object summary = execution.hasVariable("summary") ? execution.getVariable("summary") : null;
        ProcessLog.log(execution, "通知: {}",
            summary == null ? "变量: title=" + execution.getVariable("title") : summary);
        execution.setVariable("lastNotifyActivity", execution.getCurrentActivityId());
    }
}
```

### 7.3 SorExpenseDelegate —— 读取报销单（调 SOR 写流程变量）

```java
package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 读取报销单:调 SOR GET /api/expenses/{expenseId}(规格书 §7.3),把单据概要与当前状态写进流程变量;
 * 随后 PUT /api/expenses/{expenseId}/process-instance 回写流程实例 id(规格书 §8,幂等,重试安全)。
 * BPMN: flowable:async="true" + flowable:delegateExpression="${sorExpenseDelegate}",挂 R3/PT1M 重试。
 * X-Service-Key 服务间认证;HTTP/状态失败抛异常走 async Job 重试。
 */
@Component("sorExpenseDelegate")
public class SorExpenseDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorExpenseDelegate(@Value("${sor.base-url}") String baseUrl,
                              @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    @SuppressWarnings("unchecked")
    public void execute(DelegateExecution execution) {
        String expenseId = (String) execution.getVariable("expenseId");
        Map<String, Object> body = sorClient.get().uri("/api/expenses/{id}", expenseId)
            .retrieve().body(Map.class);
        Map<String, Object> data = (Map<String, Object>) body.get("data");
        // 当前状态写进流程变量,后续节点(prompt/网关)可读
        execution.setVariable("expenseStatus", data.get("status"));
        execution.setVariable("expenseTitle", data.get("title"));
        execution.setVariable("reason", data.get("reason"));
        // SOR 金额是字符串十进制,流程变量 amount 声明为 float
        execution.setVariable("amount", Double.valueOf(String.valueOf(data.get("totalAmount"))));
        List<Map<String, Object>> items = (List<Map<String, Object>>) data.get("items");
        List<Map<String, Object>> itemList = new ArrayList<>();
        for (Map<String, Object> it : items) {
            // SOR 明细字段(category/occurredDate)映射为流程明细字段(expenseType/issuedOn)
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("expenseType", it.get("category"));
            row.put("amount", Double.valueOf(String.valueOf(it.get("amount"))));
            row.put("issuedOn", it.get("occurredDate"));
            row.put("description", it.get("description"));
            itemList.add(row);
        }
        execution.setVariable("itemList", itemList);
        execution.setVariable("itemCount", itemList.size());
        // 回写流程实例 id(GUI/列表可从单据跳流程;同实例重试回写幂等)
        sorClient.put().uri("/api/expenses/{id}/process-instance", expenseId)
            .body(Map.of("processInstanceId", execution.getProcessInstanceId()))
            .retrieve().body(Map.class);
        ProcessLog.log(execution, "读取报销单 {} 标题={} 金额={} 明细 {} 行 状态={}",
            expenseId, data.get("title"), data.get("totalAmount"), itemList.size(), data.get("status"));
    }
}
```

### 7.4 SorApprovalDelegate —— 登记审批（直属/专线/财务验票三节点共用）

```java
package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.HashMap;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 登记审批:把当前审批节点的结论写进 SOR 审批记录(规格书 §7.5,幂等键=流程实例+节点+审批人),
 * 并联动迁移单据状态(§6):reject → rejected;最后审批节点通过 → approved(正式批准);
 * 其余审批节点通过 → ongoing(任一人审批过即流转中)。
 * BPMN: flowable:delegateExpression="${sorApprovalDelegate}",挂 R3/PT1M 重试。
 * 本 delegate 不调状态端点,迁移由 SOR 在落库时联动完成。
 * 结论变量读取顺序:财务验票节点写 financeVerified,审批节点写 approvalResult;
 * financeVerified 优先——审批变量在流程上下文里残留,存在性判断只对 financeVerified 可靠。
 */
@Component("sorApprovalDelegate")
public class SorApprovalDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorApprovalDelegate(@Value("${sor.base-url}") String baseUrl,
                               @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    public void execute(DelegateExecution execution) {
        boolean financeVerifiedPresent = execution.hasVariable("financeVerified")
            && execution.getVariable("financeVerified") != null;
        boolean isFinanceVerify = financeVerifiedPresent;
        String decision = isFinanceVerify
            ? (Boolean.TRUE.equals(execution.getVariable("financeVerified")) ? "approve" : "reject")
            : String.valueOf(execution.getVariable("approvalResult"));
        String comment = isFinanceVerify
            ? String.valueOf(execution.getVariable("financeNotes"))
            : String.valueOf(execution.getVariable("approvalComment"));
        Map<String, Object> request = new HashMap<>();
        request.put("processInstanceId", execution.getProcessInstanceId());
        request.put("activityId", execution.getCurrentActivityId());
        request.put("decision", decision);
        // 联动迁移目标(§6):最后审批节点(财务复核)通过 → approved(正式批准);其余 → ongoing;
        // reject 不传,SOR 固定迁移 rejected
        if ("approve".equals(decision)) {
            request.put("targetStatus", isFinanceVerify ? "approved" : "ongoing");
        }
        request.put("comment", comment);
        request.put("approverId", String.valueOf(execution.getVariable("approvalApproverId")));
        request.put("approverName", String.valueOf(execution.getVariable("approvalApproverName")));
        ProcessLog.log(execution, "登记审批请求 decision判定 财务验票变量存在 {} financeVerified {} approvalResult {}",
            financeVerifiedPresent, execution.getVariable("financeVerified"),
            execution.hasVariable("approvalResult") ? execution.getVariable("approvalResult") : "<未写>");
        ProcessLog.log(execution, "登记审批请求体 {}", request);
        Map<String, Object> sorResponse = sorClient.post()
            .uri("/api/expenses/{id}/approval-records", execution.getVariable("expenseId"))
            .body(request)
            .retrieve().body(Map.class);
        // SOR 响应 data.duplicated=true 表示幂等重放(记录已存在,不迁移状态)——排查"记录在但状态不动"的关键信号
        ProcessLog.log(execution, "登记审批完成 单据 {} 结论 {} 审批人 {} SOR响应 {}",
            execution.getVariable("expenseId"), decision,
            execution.getVariable("approvalApproverName"), sorResponse);
        // SOR 迁移成功后回写流程变量:{{expenseStatus}} 的 prompt 插值在任务创建时快照,
        // 不回写则后续节点(出纳打款)看到的仍是「读取报销单」写入的 opened
        String newStatus = "reject".equals(decision) ? "rejected"
            : (isFinanceVerify ? "approved" : "ongoing");
        execution.setVariable("expenseStatus", newStatus);
    }
}
```

### 7.5 SorPaymentDelegate —— 登记打款（写打款记录即迁 paid）

```java
package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.HashMap;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 登记打款:把流水写进 SOR 打款记录(规格书 §7.6),写入即迁移 paid。
 * BPMN: flowable:delegateExpression="${sorPaymentDelegate}",挂 R3/PT1M 重试。
 * 单据状态必须为 approved(SOR 校验,否则 409 走失败路径);重复调用(已有打款记录)同样 409。
 */
@Component("sorPaymentDelegate")
public class SorPaymentDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorPaymentDelegate(@Value("${sor.base-url}") String baseUrl,
                              @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    public void execute(DelegateExecution execution) {
        Map<String, Object> request = new HashMap<>();
        // 金额格式化为两位小数字符串,对齐 SOR"字符串十进制"约定
        request.put("amount", String.format("%.2f", (Double) execution.getVariable("amount")));
        request.put("channel", "银行转账");
        request.put("comment", "流水号 " + execution.getVariable("transactionId"));
        request.put("paidBy", String.valueOf(execution.getVariable("approvalApproverId")));
        request.put("paidName", String.valueOf(execution.getVariable("approvalApproverName")));
        sorClient.post()
            .uri("/api/expenses/{id}/payment", execution.getVariable("expenseId"))
            .body(request)
            .retrieve().body(Map.class);
        ProcessLog.log(execution, "登记打款 单据 {} 金额 {} 流水号 {}",
            execution.getVariable("expenseId"),
            execution.getVariable("amount"), execution.getVariable("transactionId"));
    }
}
```

## 8. SKILL.md（3 个）

三个 skill 的分工：`expense-submit` 供员工发起报销（建单 + 启动流程，P1 唯一入口）；`expense-lookup` 供各审批节点读单核对（P1 四个审批节点都挂它）；`universal-approver` 供审批节点输出结论 JSON。SOR 地址 demo 固定 `http://localhost:8091/api`。

### 8.1 报销单提报助手（P1 发起入口）

**目录**: `%USERPROFILE%\.dsh\skills\expense-submit\SKILL.md`

````markdown
---
name: expense-submit
description: 引导员工提报报销单：收集发票文件与明细 → 上传到费控系统 → 创建报销单拿到报销单号 → 以报销单号为输入参数启动报销流程
triggers:
  - 提交报销
  - 报销
  - 发票
---

# 报销单提报助手

## 你要做的事

1. **收集信息**：请员工提供报销事由、发票文件（pdf/png/jpeg，每张 ≤10MB）与每张发票的明细
   （费用类别：交通/住宿/餐饮/办公/其他；金额；发生日期 yyyy-MM-dd；说明）。
   缺哪项追问哪项，收集齐再继续。
2. **逐个上传附件**：对每个发票文件调用
   `POST http://localhost:8091/api/expenses/attachments`（multipart/form-data，字段 file，Authorization: Bearer 身份块认证令牌），
   记录响应 `data.id`（attachmentId）。
3. **创建报销单**：调用 `POST http://localhost:8091/api/expenses`（Authorization: Bearer 身份块认证令牌），请求体：

   ```json
   {
     "title": "<简短标题>",
     "reason": "<报销事由>",
     "submitterName": "<当前用户姓名,从身份块取>",
     "items": [
       { "category": "交通", "amount": "830.00", "occurredDate": "2026-09-10", "description": "高铁往返" }
     ],
     "attachmentIds": ["<第 2 步的 id 列表>"]
   }
   ```

   金额一律字符串十进制。响应 `data.id` 即报销单号，`data.totalAmount` 是 SOR 计算的合计——向员工复述确认。
4. **启动流程**：调用 `dsh_process_start`，发起前必须先 dsh_process_list获得流程 id ，输入变量只传
   `{ "expenseId": "<报销单号>" }`。
5. **回复员工**：报销单号、合计金额、流程已启动；后续审批待办会出现在各办理人的 DSH 待办列表。

## 注意

- 费控系统未启动时把接口错误如实告诉员工（"费控系统不可用，请稍后再试"），不要编造单号，也不要启动流程
- 建单成功但流程启动失败：单号已保留（费控系统中状态为 opened），请员工稍后重试启动，**不要重复建单**
- 单据状态流转：opened（已提交）→ ongoing（任一人审批过）→ approved（最后审批节点通过，正式批准）→ paid（已打款）；被拒 rejected；ongoing/approved 阶段可撤回 cancelled
````

### 8.2 报销单查询助手（审批节点读单）

**目录**: `%USERPROFILE%\.dsh\skills\expense-lookup\SKILL.md`

```markdown
---
name: expense-lookup
description: 按报销单号读取费控系统 单据详情（明细/附件/审批记录/打款记录），供审批复核时核对原始单据
triggers:
  - 查报销单
  - 报销单详情
  - 单据明细
---

# 报销单查询助手

## 你要做的事

1. 从任务指令里拿报销单号（expenseId）；指令没带就向用户询问。
2. 调用 `GET http://localhost:8091/api/expenses/{单号}`（Authorization: Bearer 身份块认证令牌）读取单据。
3. 向用户汇报：标题、事由、合计金额、当前状态、明细清单（每行：类别/金额/日期/说明）、
   已关联附件（下载链接形如 `GET http://localhost:8091/api/expenses/{单号}/attachments/{attachmentId}`）、
   已有审批记录（如有）（每行：审批人/审批/状态/时间）、
   打款记录（如有）（每行：打款人/打款/状态/时间）。
4. 用户要求核对时，逐张列出明细与附件的对应关系（金额勾稽：单张之和 = 合计）。

## 注意

- 只读不写：本 skill 不修改任何单据数据
- 单号不存在时如实告知，不要编造明细
- 汇报状态时翻译成中文：opened=已提交、ongoing=审批中、approved=已正式批准待打款、
  rejected=已拒绝、paid=已打款、cancelled=已撤回
```

### 8.3 通用审批决策助手（直属/专线/财务复核/出纳共用）

**目录**: `%USERPROFILE%\.dsh\skills\universal-approver\SKILL.md`

```markdown
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
- 发票要素（单张金额>0、日期距今≤3650 天、类型与事由匹配、单张之和=合计）
- 合规性（超标准要说明理由）

## 输出

以任务指令中明确要求的 JSON 字段为准（如 approvalResult/approvalComment、financeVerified/financeNotes、paymentConfirmed/transactionId、leaderOpinion），字段一个不少，输出纯 JSON，不要夹带其他内容。

## 注意

- 打款类任务的 transactionId 用模拟号（如 20260921-0001），不要编造真实流水
- 结论与意见要有依据，不复读指令
```
