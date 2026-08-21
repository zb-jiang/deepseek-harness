# Flowable 引擎验证指南

本指南给出 DSH 企业级应用平台 Flowable 引擎服务（`apps/flowable-engine/`）的端到端验证步骤，覆盖启动、表自动建、JWT 鉴权、BPMN 部署、dsh 元数据解析、自动节点回调、SoD 过滤、异步 ServiceTask、dsh 元数据缓存、历史/审计接口等关键能力。

参见:
- [开发 SPEC](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-dsh-enterprise-platform-development-spec.md)
- [Supabase 配置手册](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-supabase-setup-guide.md)
- [Flowable 引擎 README](file:///d:/works/deepseek-harness/apps/flowable-engine/README.md)

## 0. 前置条件

1. **Supabase 项目已按 [setup guide](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-supabase-setup-guide.md) 完成**：
   - `public` schema 已建 `platform_users` / `applications` / `app_roles` / `app_memberships` / `workflow_definitions` 等表
   - Supabase Auth 已启用（注册/登录可用）
2. **测试用户已注册并 approval**：
   - 在 Supabase Dashboard → Authentication → Users 中注册一个测试用户（如 `test@dsh.ai` / 密码 `Test123456!`）
   - 在 SQL Editor 中确认该用户在 `public.platform_users` 表中 `status='active'`（未审批的用户不能登录）：
     ```sql
     SELECT id, email, status FROM public.platform_users WHERE email = 'test@dsh.ai';
     ```
   - 如未审批，可手动 UPDATE：
     ```sql
     UPDATE public.platform_users
     SET status = 'active', approved_at = now(), approved_by = null
     WHERE email = 'test@dsh.ai';
     ```
3. **测试应用与角色已建**（用于 SoD 过滤验证）：
   ```sql
   -- 建应用
   INSERT INTO public.applications (id, name, description, status, app_admin_user_ids)
   VALUES ('app-test-uuid', '测试应用', '验证用', 'active', ARRAY['<test-user-uuid>']::uuid[]);

   -- 建两个角色(approver + manager,有 parent 关系演示角色继承)
   INSERT INTO public.app_roles (id, app_id, name, description, status, parent_role_id)
   VALUES
     ('role-approver-uuid', 'app-test-uuid', '审批员', '审批节点角色', 'active', null),
     ('role-manager-uuid', 'app-test-uuid', '经理', '审批员上级(超时升级目标)', 'active', 'role-approver-uuid');

   -- 把测试用户加入 app_memberships,绑定 approver 角色
   INSERT INTO public.app_memberships (app_id, user_id, role_ids, status, granted_by)
   VALUES ('app-test-uuid', '<test-user-uuid>',
           ARRAY['role-approver-uuid']::uuid[], 'active', null);
   ```
4. **(可选) 第二个应用与角色(用于应用隔离验证,见 §0.4 与步骤 8.5)**：
   ```sql
   -- 建第二个应用(可与第一个同名,验证应用名可重名但 id 唯一)
   INSERT INTO public.applications (id, name, description, status, app_admin_user_ids)
   VALUES ('app-test2-uuid', '测试应用二', '隔离验证用', 'active',
           ARRAY['<test-user-uuid>']::uuid[]);

   -- 在第二个应用下建一个 <同> 名角色"审批员"(验证应用内角色名唯一不跨应用冲突)
   INSERT INTO public.app_roles (id, app_id, name, description, status, parent_role_id)
   VALUES ('role-approver2-uuid', 'app-test2-uuid', '审批员', '应用二审批角色',
           'active', null);

   -- 给同一测试用户在应用二也加一条 membership(验证同一用户可属于多个应用)
   INSERT INTO public.app_memberships (app_id, user_id, role_ids, status, granted_by)
   VALUES ('app-test2-uuid', '<test-user-uuid>',
           ARRAY['role-approver2-uuid']::uuid[], 'active', null);

   -- 在应用二下再建一个测试用户(用于跨应用待办不可见验证)
   INSERT INTO public.app_memberships (app_id, user_id, role_ids, status, granted_by)
   VALUES ('app-test2-uuid', '<test-user2-uuid>',
           ARRAY['role-approver2-uuid']::uuid[], 'active', null);
   ```
5. **(可选) 服务器端 DSH web profile daemon**（用于自动节点回调验证，步骤 9）：
   - 若暂未实现 DSH web profile，可跳过步骤 9；或用 mock server（如 Python `http.server` 或 `nc -l 3080`）返回固定 JSON

## 1. 设置环境变量（PowerShell）

打开 PowerShell，设置环境变量（替换 `<project-ref>` 与密码为你的 Supabase 项目实际值）：

```powershell
$env:SUPABASE_DB_HOST="db.<project-ref>.supabase.co"
$env:SUPABASE_DB_USER="postgres"
$env:SUPABASE_DB_PASSWORD="<数据库密码>"
$env:SUPABASE_JWT_SECRET="<Supabase JWT Secret>"
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:DSH_WEB_PROFILE_BASE_URL="http://127.0.0.1:3080"
```

**JWT Secret 获取**：Supabase Dashboard → Project Settings → API → JWT Secret（注意不是 anon/service_role key，是更下方的 "JWT Secret"，64 字符长字符串）。

**secret encoding**：默认 `utf8`（raw 字符串字节）。如验证 JWT 时报 "signature mismatch"，改 `application.yml` 中 `dsh.supabase.jwt-secret-encoding: base64` 后重启。

## 2. 启动 Flowable 引擎

```powershell
cd d:\works\deepseek-harness\apps\flowable-engine
& "D:\apache-maven-3.9.9-bin\apache-maven-3.9.9\bin\mvn.cmd" spring-boot:run "-Dspring-boot.run.profiles=dev"
```

**预期日志**：
```
Started FlowableEngineApplication in X.X seconds
...Initializing 30+ ACT_* tables in schema 'flowable'...
...Tomcat started on port 8090...
```

**故障排查**：
- 连接超时：确认 `SUPABASE_DB_HOST` 是 `db.<project-ref>.supabase.co` 不是 pooler 地址
- 密码错误：在 Supabase Dashboard → Project Settings → Database 重置密码
- 端口占用 8090：改 `application.yml` 的 `server.port`

## 3. 验证 ACT_* 表自动建

在 Supabase Dashboard → SQL Editor 执行：

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'flowable' ORDER BY tablename;
```

**预期结果**：30+ 表，包括：
- `act_re_deployment` / `act_re_procdef` —— 部署与流程定义
- `act_ru_task` / `act_ru_variable` / `act_ru_identitylink` —— 运行时任务/变量/候选
- `act_hi_taskinst` / `act_hi_actinst` / `act_hi_procinst` —— 历史

如未看到表：检查启动日志是否有 schema 创建错误；确认数据库用户有 DDL 权限（V1 用 postgres 超级用户）。

## 4. 拿测试 JWT

### 4.1 注册测试用户（如未注册）

```powershell
$anonKey="<Supabase anon key>"
curl -X POST "$env:SUPABASE_URL/auth/v1/signup" `
  -H "apikey: $anonKey" `
  -H "Content-Type: application/json" `
  -d '{"email":"test@dsh.ai","password":"Test123456!"}'
```

### 4.2 登录拿 access_token

```powershell
$resp = curl -X POST "$env:SUPABASE_URL/auth/v1/token?grant_type=password" `
  -H "apikey: $anonKey" `
  -H "Content-Type: application/json" `
  -d '{"email":"test@dsh.ai","password":"Test123456!"}' | ConvertFrom-Json
$jwt = $resp.access_token
echo "JWT 长度: $($jwt.Length)"
echo "user.id (sub claim): $($resp.user.id)"
```

记录 `$jwt`（后续步骤用），并确认 `$resp.user.id` 与 `platform_users.id` 一致。

**故障排查**：
- "Email not confirmed"：在 Supabase Dashboard → Authentication → Users 找到该用户 → 点 "Confirm user"
- "Invalid login"：确认密码与注册时一致

## 5. 部署测试 BPMN

测试 BPMN 文件 [sample-approval-process.bpmn20.xml](file:///d:/works/deepseek-harness/apps/flowable-engine/examples/sample-approval-process.bpmn20.xml) 含一个 userTask（配 dsh: 五要素 + actionPolicy 含 SoD 规则）+ 一个 ServiceTask（绑 `dshServiceTaskDelegate`）。

```powershell
curl -X POST "http://localhost:8090/process-api/repository/deployments" `
  -H "Authorization: Bearer $jwt" `
  -F "file=@examples/sample-approval-process.bpmn20.xml"
```

**预期响应**：返回 JSON 含 `id`（deployment id）、`name`、`deployedProcessDefinitions` 等。

**故障排查**：
- 401 Unauthorized：JWT 已过期或签名验证失败，重新登录拿新 token
- 400 Bad Request：BPMN XML 格式错误，检查 XML 是否 well-formed

## 6. 启动流程实例

```powershell
$resp = curl -X POST "http://localhost:8090/process-api/runtime/process-instances" `
  -H "Authorization: Bearer $jwt" `
  -H "Content-Type: application/json" `
  -d '{
    "processDefinitionKey":"dshSampleApproval",
    "variables":{
      "applicationSummary":"测试申请:采购办公设备",
      "amount":5000,
      "dsh_applicant_user_id":"<其他用户id,演示 not-applicant SoD>"
    }
  }' | ConvertFrom-Json
$processInstanceId = $resp.id
echo "实例 id: $processInstanceId"
```

**预期行为**：
- Flowable 自动 create `approveTask`（userTask 节点）
- `DshBpmnParseHandler` 已在部署时为该 userTask 注入 `DshTaskListener`
- `DshTaskListener` 在 create 事件触发时：
  1. 解析 BPMN 的 dsh extensionElements → DshExtensionProperties POJO
  2. JSON 序列化注入 task-local 变量 `dsh_node_meta` / `dsh_node_id`
  3. 解析 `sodRules`（含 `not-applicant`），调 `DshSodFilter` 过滤候选 users（排除 applicant），结果写入 `task.candidateUsers`，标记 `dsh_sod_applied=true`

## 7. 验证 JWT 鉴权

```powershell
# 不带 token,应返回 401
curl -i "http://localhost:8090/dsh/tasks/my-tasks"

# 带正确 token,应返回 200 + JSON 数组(可能为空,因为 task 未认领给当前 user)
curl "http://localhost:8090/dsh/tasks/my-tasks" -H "Authorization: Bearer $jwt"
```

**预期**：
- 不带 token：HTTP 401 + `WWW-Authenticate: Bearer` 头
- 带过期/伪造 token：HTTP 401 + 错误说明
- 带正确 token：HTTP 200 + `[]` 或 `[...]`

## 8. 验证 dsh_node_meta 已注入

在 Supabase SQL Editor：

```sql
SELECT t.id_ AS task_id,
       t.name_ AS task_name,
       t.task_def_key_ AS node_id,
       t.assignee_,
       v.name_ AS var_name,
       LEFT(v.text_, 200) AS var_value_preview
FROM flowable.act_ru_task t
LEFT JOIN flowable.act_ru_variable v ON v.task_id_ = t.id_
WHERE t.task_def_key_ = 'approveTask'
ORDER BY v.name_;
```

**预期结果**：3 行 task-local 变量：
- `dsh_node_meta`：JSON 字符串，含 `systemPrompt` / `userPrompt` / `inputSchema` / `outputSchema` / `skillRefs` / `actionPolicy` / `assignmentRule` 字段
- `dsh_node_id`：`approveTask`
- `dsh_sod_applied`：`true`

**完整查看 dsh_node_meta**（验证五要素 + SoD 配置都正确解析）：

```sql
SELECT v.text_ AS dsh_node_meta_json
FROM flowable.act_ru_variable v
WHERE v.name_ = 'dsh_node_meta'
  AND v.task_id_ = (SELECT id_ FROM flowable.act_ru_task WHERE task_def_key_ = 'approveTask' LIMIT 1);
```

**验证 candidateUsers 已被 SoD 过滤**：

```sql
SELECT i.user_id_ AS candidate_user,
       u.email AS user_email
FROM flowable.act_ru_identitylink i
LEFT JOIN public.platform_users u ON u.id::text = i.user_id_
WHERE i.task_id_ = (SELECT id_ FROM flowable.act_ru_task WHERE task_def_key_ = 'approveTask' LIMIT 1)
  AND i.type_ = 'candidate';
```

**预期**：候选 users 不包含步骤 6 中 `dsh_applicant_user_id` 指定的用户（not-applicant 规则生效）。

### 8.5 (可选) 验证应用隔离

前置:步骤 0.4 已建第二个应用 `app-test2-uuid`、应用二下角色 `role-approver2-uuid`(与应用一同名"审批员",验证应用内角色名唯一不跨应用冲突)、测试用户在应用二的 membership,以及 `test-user2-uuid` 在应用二的 membership。

**1) 验证应用内角色名唯一(跨应用可重名)**：

```sql
-- 查两个应用下都有名为"审批员"的角色,各属不同 app_id,不冲突
SELECT id, app_id, name FROM public.app_roles WHERE name = '审批员' ORDER BY app_id;
```

**预期**:返回两行,`app_id` 分别为 `app-test-uuid` 和 `app-test2-uuid`,`id` 分别为 `role-approver-uuid` 和 `role-approver2-uuid`。

**2) 验证 DshMembershipRepository 按 role_id 查询不跨应用串扰**:

部署应用二自己的 BPMN(可手写一个 BPMN,userTask 配 `flowable:candidateGroups="role-approver2-uuid"`),启动实例后查 task 的候选 users:

```sql
-- 应用二 task 的候选 users 应只来自 app_test2_uuid 下的 membership
SELECT i.user_id_, m.app_id
FROM flowable.act_ru_identitylink i
JOIN flowable.act_ru_task t ON t.id_ = i.task_id_
LEFT JOIN public.app_memberships m ON m.user_id::text = i.user_id_
WHERE i.type_ = 'candidate'
  AND t.task_def_key_ = '<应用二 userTask def key>';
```

**预期**:候选 `user_id_` 对应的 `m.app_id` 全部为 `app-test2-uuid`,不应出现 `app-test-uuid` 的成员(应用一的 `test-user` 即使在应用一也持有同名"审批员"角色,也不应被应用二 task 候选)。

**3) 验证同一用户跨应用 membership 独立**:

```sql
-- 同一用户 test-user-uuid 在两个应用各有一条 membership
SELECT app_id, user_id, role_ids
FROM public.app_memberships
WHERE user_id = '<test-user-uuid>'::uuid;
```

**预期**:两行,`app_id` 分别为 `app-test-uuid` 与 `app-test2-uuid`,role_ids 各自只含本应用的 role_id。

**4) 验证 DshSodFilter mutex-node 排除集不跨应用**:

在应用二启动实例并完成一个 userTask,再创建第二个 userTask(配 `mutex-node` SoD 规则),查第二个 task 的候选排除集:

```sql
-- 第二个 task 候选不应包含应用一实例的 assignee
SELECT i.user_id_ AS candidate
FROM flowable.act_ru_identitylink i
WHERE i.task_id_ = '<应用二第二个 task id>' AND i.type_ = 'candidate';
```

**预期**:候选 users 全部来自应用二实例,mutex-node 排除集(`historic task.assignee` of same `processInstanceId`)只取自应用二实例,不会把应用一实例的 assignee 排除进来。

**5) 验证 Web Console 发布 BPMN 时校验 role_id 归属**(实现后):

构造一个 BPMN,userTask 的 `flowable:candidateGroups` 故意填应用二的 role_id,但 `workflow_definitions.app_id` 是应用一,通过 Web Console 发布接口提交,应返回 400 拒绝,提示"role_id 不属于本应用"。

> V1 单企业内部信任,引擎层不重复校验 role_id 归属;此步验证 Web Console 应用层把关,见 [开发 SPEC §12.10 与 §13.4.2](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-dsh-enterprise-platform-development-spec.md)。

## 9. 验证自动节点（async ServiceTask,V1 改进）

V1 改进后 BPMN sample 的 ServiceTask 已配 `flowable:async="true"`，引擎不再同步调用 `DshServiceTaskDelegate`，而是把 Job 写入 `ACT_RU_JOB`，由 `async-executor` 线程池异步消费。本节验证这一异步路径。

### 9.1 启动 DSH web profile daemon 或 mock

**方案 A：mock server（PowerShell，开新终端）**

```powershell
# 简单 mock:监听 3080,返回固定 JSON
# 用 Python 内置 http.server 起 mock
@"
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class MockHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/enterprise/auto-node/execute':
            content_length = int(self.headers['Content-Length'])
            self.rfile.read(content_length)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'output': {'archived': True, 'documentId': 'doc-12345'},
                'notes': '归档完成,生成归档编号 doc-12345',
                'success': True,
                'error': None
            }
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self.end_headers()

HTTPServer(('127.0.0.1', 3080), MockHandler).serve_forever()
"@ | Out-File -Encoding UTF8 mock_server.py
python mock_server.py
```

**方案 B：真实 DSH web profile**（V2 实现，V1 验证可用方案 A）

### 9.2 认领并完成 approveTask

```powershell
# 查询当前 task id
$taskId = (curl "http://localhost:8090/process-api/runtime/tasks?taskDefinitionKey=approveTask" `
  -H "Authorization: Bearer $jwt" | ConvertFrom-Json).data[0].id

# 认领(task.assignee = 当前 user)
curl -X POST "http://localhost:8090/process-api/runtime/tasks/$taskId" `
  -H "Authorization: Bearer $jwt" `
  -H "Content-Type: application/json" `
  -d '{"action":"claim"}'

# 完成,提交 output 变量(下游 ServiceTask 消费)
curl -X POST "http://localhost:8090/process-api/runtime/tasks/$taskId" `
  -H "Authorization: Bearer $jwt" `
  -H "Content-Type: application/json" `
  -d '{
    "action":"complete",
    "variables":[
      {"name":"output","value":{"conclusion":"approved","comment":"通过,金额合理"}}
    ]
  }'
```

### 9.3 验证 async Job 已创建并由 async-executor 消费

complete 后**立即**查 `ACT_RU_JOB`（async Job 短暂存在,被 async-executor 消费后删除）：

```sql
SELECT id_, proc_inst_id_, proc_def_id_, element_id_, retries_, exception_msg_
FROM flowable.act_ru_job
WHERE proc_def_id_ LIKE 'dshSampleApproval:%'
ORDER BY id_ DESC LIMIT 5;
```

**预期**：complete 后极短时间内能看到 `element_id_='autoArchiveTask'` 的 async Job；mock server 返回 success 后 Job 被消费删除；引擎把响应 `output` 写入实例变量 `dsh_auto_output`。

观察 Flowable 引擎日志，应看到（async-executor 工作线程执行）：
```
DshServiceTaskDelegate.execute - calling DSH web profile at 127.0.0.1:3080
... HTTP 200, output: {"archived":true,"documentId":"doc-12345"}
```

**验证实例已完成**（async-executor 处理完 Job 后流程才走到 endEvent）：

```sql
SELECT id_, business_key_, end_time_, delete_reason_
FROM flowable.act_hi_procinst
WHERE proc_def_id_ LIKE 'dshSampleApproval:%'
ORDER BY end_time_ DESC LIMIT 5;
```

**预期**：mock 返回 success 后短时间内 `end_time_` 非空（实例已完成）。如果一直为空，查 `ACT_RU_JOB` 是否有 deadletter（exception_msg_ 非空，retries_=0）。

**验证自动节点产出已写入实例变量**：

```sql
SELECT name_, text_ AS value_preview
FROM flowable.act_hi_varinst
WHERE proc_inst_id_ = '<processInstanceId>'
  AND name_ IN ('dsh_auto_output', 'dsh_auto_notes', 'output');
```

**预期**：`dsh_auto_output` 含 `{"archived":true,"documentId":"doc-12345"}`，`dsh_auto_notes` 含 "归档完成,生成归档编号 doc-12345"。

### 9.4 验证失败重试（可选）

临时关停 mock server，complete approveTask 让 async Job 执行失败：

```sql
-- 失败后立即查 ACT_RU_JOB
SELECT retries_, exception_msg_, duedate_
FROM flowable.act_ru_job
WHERE element_id_ = 'autoArchiveTask'
ORDER BY id_ DESC LIMIT 1;
```

**预期**：`retries_` 从 5 递减（按 `R5/PT5M` 配置），`exception_msg_` 含 `Connection refused`，`duedate_` 是下次重试时间（+5 分钟）。重启 mock server，等下次重试周期或手动改 `duedate_=now()` 触发立即重试，Job 应能成功。

全部失败后 Job 移到 `ACT_RU_DEADLETTER`：

```sql
SELECT id_, proc_inst_id_, element_id_, exception_msg_, retries_
FROM flowable.act_ru_deadletter
ORDER BY id_ DESC LIMIT 5;
```

## 10. 验证超时升级（可选）

V1 超时升级用 BPMN timer boundary event 实现，需要 BPMN 含 boundaryEvent 配置（[SPEC §6.8.1](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-dsh-enterprise-platform-development-spec.md#L608)）。当前 sample-approval-process.bpmn20.xml 未配 timer，可手写一个测试 BPMN：

```xml
<userTask id="approveTask" flowable:candidateGroups="role-approver-uuid">
  <extensionElements>
    <dsh:actionPolicy>
      <dsh:timeoutPolicy duration="PT1M" escalateToRoleId="role-manager-uuid"/>
    </dsh:actionPolicy>
  </extensionElements>
</userTask>
<boundaryEvent id="approveTimeout" attachedToRef="approveTask" cancelActivity="false">
  <timerEventDefinition>
    <timeDuration>PT1M</timeDuration>
  </timerEventDefinition>
</boundaryEvent>
<sequenceFlow sourceRef="approveTimeout" targetRef="escalateTask"/>
<userTask id="escalateTask" flowable:candidateGroups="role-manager-uuid">
  <extensionElements>
    <dsh:assignmentRule candidateRoleId="role-manager-uuid" taskStrategy="single"/>
    <!-- 继承原节点五要素 -->
  </extensionElements>
</userTask>
```

部署此 BPMN 后启动实例，**等待 1 分钟**（timer duration），观察：
- 引擎日志：timer 触发，创建 `escalateTask`
- `escalateTask` 的 candidateGroup = `role-manager-uuid`，候选用户含 manager 角色成员
- 原 `approveTask` 仍保留（cancelActivity=false）

## 11. 验证委托代理（可选）

```powershell
# A 把 task 委托给 B(B 是另一个已注册的 active 用户)
$taskId="<approveTask id>"
$userBId="<B 的 user.id>"
curl -X POST "http://localhost:8090/process-api/runtime/tasks/$taskId" `
  -H "Authorization: Bearer $jwtA" `
  -H "Content-Type: application/json" `
  -d "{`"action`":`"delegate`",`"userId`":`"$userBId`"}"

# 用 B 的 token 查 my-tasks,应看到该 task(assignee=B, owner=A, delegationState=PENDING)
curl "http://localhost:8090/dsh/tasks/my-tasks" -H "Authorization: Bearer $jwtB"

# B 完成 task
curl -X POST "http://localhost:8090/process-api/runtime/tasks/$taskId" `
  -H "Authorization: Bearer $jwtB" `
  -H "Content-Type: application/json" `
  -d '{"action":"complete","variables":[...]}'
```

## 12. 验证 async-executor 线程池调优（V1 改进）

`async-executor` 默认线程池 `core=2/max=10/queue=20000`，V1 在 application.yml 调为 `core=4/max=16/queue=1000`，更适合单企业单实例 + LLM I/O 密集场景。本节确认线程池参数已生效。

### 12.1 检查配置加载

启动后访问 `/actuator/configprops`（如启用 actuator）或查日志：

```powershell
# 启动日志应能看到 async executor 相关
curl "http://localhost:8090/actuator/configprops" -H "Authorization: Bearer $jwt" 2>$null
```

或直接在 application.yml 确认以下配置：

```yaml
spring:
  flowable:
    async-executor-activate: true
    async-executor-core-pool-size: 4
    async-executor-max-pool-size: 16
    async-executor-queue-capacity: 1000
    async-executor-async-job-lock-time: 300000
    async-executor-timer-lock-time: 300000
```

### 12.2 压测并发 async Job（可选）

并发启动多个流程实例（同时触发多个 async Job），观察 async-executor 工作线程数：

```powershell
# 并发启动 20 个实例（每个都会触发 async ServiceTask）
1..20 | ForEach-Object -Parallel {
    curl -X POST "http://localhost:8090/process-api/runtime/process-instances" `
      -H "Authorization: Bearer $using:jwt" `
      -H "Content-Type: application/json" `
      -d '{"processDefinitionKey":"dshSampleApproval","variables":{"applicationSummary":"批量测试","amount":100,"dsh_applicant_user_id":"x"}}' | Out-Null
} -ThrottleLimit 20
```

观察引擎日志：async-executor 工作线程数应稳定在 4（core），并发超 4 时入队列，再超 16 才扩容到 max。

### 12.3 调优建议

- **LLM 平均耗时 ~30s**：单实例并发上限 = max × (1 / 30s) ≈ 16 / 30 ≈ 0.53 RPS（每秒完成 0.53 个 LLM 调用）。如实例并发 > 1 RPS，应调高 max-pool-size 或加队列缓冲。
- **Job 队列满**：日志会打 `Could not acquire async job ... queue capacity reached`，调大 queue-capacity 或加 max-pool-size。
- **多实例部署**：async-job-lock-time 防止多实例同时执行同一 Job；锁时长按 LLM 调用最长耗时 + 20% 余量调。

## 13. 验证 dsh 元数据缓存（V1 改进）

`DshExtensionPropertiesCache` 是进程级 `ConcurrentHashMap`，key 为 `(procdefId, taskDefKey)`。首次 task create miss 时解析并回填，后续同节点实例直接读 cache。本节验证缓存命中路径。

### 13.1 启动多个实例验证 cache 复用

```powershell
# 启动 2 个实例,均会创建 approveTask 节点
$resp1 = curl -X POST "http://localhost:8090/process-api/runtime/process-instances" `
  -H "Authorization: Bearer $jwt" `
  -H "Content-Type: application/json" `
  -d '{"processDefinitionKey":"dshSampleApproval","variables":{"applicationSummary":"实例1","amount":1,"dsh_applicant_user_id":"x"}}' | ConvertFrom-Json

$resp2 = curl -X POST "http://localhost:8090/process-api/runtime/process-instances" `
  -H "Authorization: Bearer $jwt" `
  -H "Content-Type: application/json" `
  -d '{"processDefinitionKey":"dshSampleApproval","variables":{"applicationSummary":"实例2","amount":2,"dsh_applicant_user_id":"x"}}' | ConvertFrom-Json
```

### 13.2 验证两个实例 task 的 dsh_node_meta 一致

```sql
SELECT t.proc_inst_id_, v.text_ AS meta_preview
FROM flowable.act_ru_task t
JOIN flowable.act_ru_variable v ON v.task_id_ = t.id_ AND v.name_ = 'dsh_node_meta'
WHERE t.task_def_key_ = 'approveTask';
```

**预期**：两行 meta_preview 内容完全一致（来自同一 procdefId 同一节点的 cache 复用）。如不一致说明 cache 没生效。

### 13.3 验证 cache miss 只发生一次

观察引擎 DEBUG 日志（application-dev.yml 已设 `com.dsh.flowable: DEBUG`）：

```
# 第一个实例创建 task 时:
DshTaskListener - cache miss for procdefId=dshSampleApproval:1:xxx, taskDefKey=approveTask, fallback to BpmnModel
# 第二个实例创建同节点 task 时:
# (无 miss 日志,直接命中 cache)
```

如果没有 miss 日志，说明 cache 在两次创建之间已填充。可通过 `DshExtensionPropertiesCache.size()` 间接确认（如启用 actuator 暴露 metric）。

### 13.4 验证节点无 dsh 元素时的 cache 表现

部署一个 BPMN 含未配 `dsh:extensionElements` 的 userTask（普通 BPMN），启动实例后查：

```sql
-- 应无 dsh_node_meta 变量,但 cache 已存 Optional.empty()
SELECT v.name_ FROM flowable.act_ru_variable v
JOIN flowable.act_ru_task t ON v.task_id_ = t.id_
WHERE t.task_def_key_ = 'noDshUserTask';
```

**预期**：无 `dsh_node_meta` 变量；引擎 DEBUG 日志应只看到一次 "cache miss, parsed null" 后续同节点实例直接读 `Optional.empty()` 跳过解析。

## 14. 验证历史/审计接口（V1 改进）

`DshHistoryController` 在 Flowable 自带 `/process-api/history/*` 之上做薄封装，提供 `/dsh/history/tasks`、`/dsh/history/process-instances`、`/dsh/history/activities` 三个端点。本节验证其查询能力。

### 14.1 验证历史任务查询

前提：步骤 6-9 已完成至少一个流程实例（产生历史任务）。

```powershell
# 查当前用户处理过的历史任务(默认按 JWT sub 过滤)
curl "http://localhost:8090/dsh/history/tasks?page=0&size=20" `
  -H "Authorization: Bearer $jwt"

# 只看已完成的
curl "http://localhost:8090/dsh/history/tasks?finished=true&page=0&size=20" `
  -H "Authorization: Bearer $jwt"

# 按实例查
curl "http://localhost:8090/dsh/history/tasks?processInstanceId=$processInstanceId" `
  -H "Authorization: Bearer $jwt"
```

**预期响应**（JSON 数组）：

```json
[
  {
    "id":"<taskId>",
    "processInstanceId":"<procInstId>",
    "processDefinitionId":"dshSampleApproval:1:<deployId>",
    "taskDefinitionKey":"approveTask",
    "name":"审批",
    "assignee":"<user.id>",
    "startTime":"2026-08-21T10:00:00Z",
    "endTime":"2026-08-21T10:05:30Z",
    "durationInMillis":330000,
    "deleteReason":null,
    "dshMeta":{
      "assignmentRule":{"candidateRoleId":"role-approver-uuid","taskStrategy":"single"},
      "inputSchema":"...",
      "outputSchema":"...",
      "systemPrompt":"你是企业审批助手...",
      "userPrompt":"请审批以下申请...",
      "skillRefs":["approval-helper","compliance-check"],
      "actionPolicy":{"timeoutPolicy":{"duration":"PT24H","escalateToRoleId":"role-manager-uuid"},"sodRules":[{"type":"not-applicant"}]}
    },
    "nodeId":"approveTask"
  }
]
```

注意：历史任务也含 `dshMeta`（从 `dsh_node_meta` task-local 变量还原），方便审计页对比运行时和历史节点配置。

### 14.2 验证历史流程实例查询

```powershell
# 查全部历史实例(管理员视图,无 startedBy 过滤)
curl "http://localhost:8090/dsh/history/process-instances?page=0&size=20" `
  -H "Authorization: Bearer $jwt"

# 按发起人 + 只看已完成的
curl "http://localhost:8090/dsh/history/process-instances?startedBy=$($resp.user.id)&finished=true" `
  -H "Authorization: Bearer $jwt"

# 按 processDefinitionKey 过滤(同流程不同版本一并查)
curl "http://localhost:8090/dsh/history/process-instances?processDefinitionKey=dshSampleApproval" `
  -H "Authorization: Bearer $jwt"
```

**预期响应**（JSON 数组）：

```json
[
  {
    "id":"<procInstId>",
    "processDefinitionId":"dshSampleApproval:1:<deployId>",
    "processDefinitionKey":"dshSampleApproval",
    "processDefinitionName":"DSH 示例审批流程",
    "processDefinitionVersion":1,
    "businessKey":null,
    "startUserId":"<user.id>",
    "startTime":"2026-08-21T09:50:00Z",
    "endTime":"2026-08-21T10:10:00Z",
    "durationInMillis":1200000,
    "deleteReason":null,
    "superProcessInstanceId":null
  }
]
```

注意：`deleteReason` 为 null 表示正常完成；非 null 表示被管理员强制终止。

### 14.3 验证历史活动查询

```powershell
# 按 processInstanceId 必填
curl "http://localhost:8090/dsh/history/activities?processInstanceId=$processInstanceId" `
  -H "Authorization: Bearer $jwt"
```

**预期**：返回实例走过的全部节点活动（按时间升序），涵盖 userTask / serviceTask / startEvent / endEvent / sequenceFlow 等。注意 serviceTask 也会有一条 activity（即使 async 也会记录活动历史）。

```json
[
  {"id":"...","activityId":"startEvent","activityType":"startEvent","startTime":"...","endTime":"..."},
  {"id":"...","activityId":"approveTask","activityType":"userTask","assignee":"<user.id>","startTime":"...","endTime":"..."},
  {"id":"...","activityId":"autoArchiveTask","activityType":"serviceTask","startTime":"...","endTime":"..."},
  {"id":"...","activityId":"endEvent","activityType":"endEvent","startTime":"...","endTime":"..."}
]
```

**故障排查**：如果 `/activities` 返回空数组，确认 `FlowableConfig` 中 `historyLevel=FULL`（覆盖 ACT_HI_ACTINST），并确认实例已正常推进过节点。

### 14.4 验证必填参数校验

```powershell
# 不传 processInstanceId 应返回 400
curl "http://localhost:8090/dsh/history/activities" -H "Authorization: Bearer $jwt"
```

**预期**：HTTP 400 + 错误信息 `processInstanceId parameter is required for /dsh/history/activities`。

### 14.5 验证分页参数上限

```powershell
# size 超过 200 应被 clamp 到 200(不报错,只返回 200 条)
curl "http://localhost:8090/dsh/history/tasks?size=9999" -H "Authorization: Bearer $jwt"
```

## 故障排查

### 启动失败

| 错误 | 原因 | 解决 |
|------|------|------|
| `Connection refused: db.xxx.supabase.co:5432` | 数据库 host 错或网络不通 | 确认 `SUPABASE_DB_HOST` 是 `db.<project-ref>.supabase.co`；不要用 pooler 连接（pooler 不支持 DDL） |
| `FATAL: password authentication failed` | 数据库密码错 | 在 Supabase Dashboard → Project Settings → Database 重置密码 |
| `Port 8090 was already in use` | 端口被占 | 改 `application.yml` 的 `server.port` |
| `Schema 'flowable' does not exist` | schema 未授权 | 确认 Supabase 手册 §6 已执行 `CREATE SCHEMA IF NOT EXISTS flowable` |

### JWT 鉴权失败

| 错误 | 原因 | 解决 |
|------|------|------|
| 401 `Bearer error="invalid_token"` | JWT 签名验证失败 | 检查 `SUPABASE_JWT_SECRET` 与 Supabase 实际 JWT Secret 一致；尝试切换 `jwt-secret-encoding: utf8 / base64` |
| 401 `invalid_token ... iss claim` | iss 校验失败 | 检查 `SUPABASE_URL` 与 Supabase Project URL 一致（带 `https://`） |
| 401 after some time | JWT 过期（Supabase 默认 1 小时） | 重新登录拿新 token |

### BPMN 部署失败

| 错误 | 原因 | 解决 |
|------|------|------|
| 400 `Could not parse BPMN` | XML 格式错 | 用 XML 工具验证 well-formed；namespace 声明完整 |
| 400 `dsh: prefix not bound` | 未声明 dsh namespace | 在 `<definitions>` 加 `xmlns:dsh="http://dsh.ai/bpmn"` |
| 部署成功但 task create 报错 | DshTaskListener 执行失败 | 查引擎日志的 stack trace，多为 BPMN extensionElements 解析问题 |

### dsh_node_meta 为空

可能原因：
- BPMN userTask 未配 `dsh:extensionElements` —— 检查 BPMN XML
- `DshBpmnParseHandler` 未注册 —— 查 `FlowableConfig` 的 `dshEngineConfigurer` Bean 是否生效（看启动日志）
- `DshTaskListener` 在 create 事件抛异常 —— 查引擎日志 stack trace
- BPMN 已部署但实例用的是旧版本 —— 重新部署 BPMN（每次部署产生新 procdef 版本，启动实例时用最新版本）

### SoD 候选过滤未生效

排查：
1. BPMN `dsh:actionPolicy.sodRules` 是否非空：
   ```sql
   SELECT v.text_ FROM flowable.act_ru_variable v
   WHERE v.name_ = 'dsh_node_meta' AND v.task_id_ = '<taskId>';
   ```
   确认 JSON 中 `actionPolicy.sodRules` 数组非空。
2. `dsh_sod_applied` 是否为 `true`：
   ```sql
   SELECT v.text_ FROM flowable.act_ru_variable v
   WHERE v.name_ = 'dsh_sod_applied' AND v.task_id_ = '<taskId>';
   ```
3. 候选 users 是否包含 applicant：
   ```sql
   SELECT i.user_id_ FROM flowable.act_ru_identitylink i
   WHERE i.task_id_ = '<taskId>' AND i.type_ = 'candidate';
   ```
   如果包含 applicant，说明 `dsh_applicant_user_id` 实例变量未设置或与 applicant 不匹配。

### 自动节点回调失败

| 错误 | 原因 | 解决 |
|------|------|------|
| `WebClientResponseException: Connection refused` | DSH web profile 未启动 | 启动 mock server 或真实 DSH web profile |
| `IllegalStateException: DSH web profile execution failed` | mock 返回 `success=false` | 检查 mock 响应 JSON 格式 |
| 流程卡在 `autoArchiveTask` 不前进 | delegate 执行抛异常 | 查引擎日志 stack trace；实例变量 `dsh_auto_output` 是否已写入 |

### 异步 ServiceTask（V1 改进）故障

| 错误 | 原因 | 解决 |
|------|------|------|
| complete approveTask 后流程不动 | async-executor 未激活 | 检查 application.yml `spring.flowable.async-executor-activate: true`；查启动日志是否报 `async executor not started` |
| Job 在 ACT_RU_JOB 不被消费 | async-executor 工作线程阻塞或线程池满 | 查线程 dump 是否有 `flowable-task-` 工作线程在等 WebClient；调大 `async-executor-max-pool-size` |
| 一直看到 Job 重试（retries 递减） | DSH web profile 调用失败 | 修复 mock/profile 后等下次重试周期，或手动 UPDATE `ACT_RU_JOB.duedate_=now()` 立即重试 |
| Job 全部失败进 deadletter | 重试 5 次均失败 | 查 `ACT_RU_DEADLETTER.exception_msg_`；修复后用 `ManagementService.moveDeadLetterJob()` 重投 |
| async-executor 配置不生效 | yaml 属性名错或被覆盖 | 确认是 `spring.flowable.async-executor-*` 前缀，非 `flowable.async-executor-*`；查 `/actuator/configprops`（启用 actuator 时）|

### dsh 元数据缓存（V1 改进）故障

| 错误 | 原因 | 解决 |
|------|------|------|
| 每次创建同节点 task 都打 miss 日志 | cache 未注入或被覆盖 | 确认 `DshTaskListener` 构造含 `DshExtensionPropertiesCache`；查 Spring 启动日志是否成功装配 `DshExtensionPropertiesCache` Bean |
| cache size 不增长 | `cache.put` 未被调 | 查 `DshTaskListener.resolveProperties` 是否走 fallback 路径；可能 BpmnModel 一直返回 null（procdefId 不匹配）|
| 同节点不同实例 meta 不一致 | procdefId 变了导致 cache miss | 正常：部署新 BPMN 版本后新 procdefId，旧 cache 自然 miss；如未重新部署却变化，查 `ACT_RE_PROCDEF` 是否有意外多版本 |

### 历史/审计接口（V1 改进）故障

| 错误 | 原因 | 解决 |
|------|------|------|
| `/dsh/history/tasks` 返回空数组 | 当前 JWT 用户没处理过任务 | 显式传 `assignee=<其他用户>` 查指定用户；或部署并完成至少一个流程 |
| `/dsh/history/process-instances` 返回少 | V1 历史级别不够 | 确认 `FlowableConfig.historyLevel=FULL`；查 `ACT_HI_PROCINST` 是否有数据 |
| `/dsh/history/activities` 返回 400 | 未传 `processInstanceId` | 必填 `?processInstanceId=<id>`；如已传仍 400 检查实例 id 是否在 `ACT_HI_ACTINST` 存在 |
| `/dsh/history/activities` 返回空 | 该实例尚未推进过节点 | 确认实例已 startEvent 至少到下一个节点；查 `ACT_HI_ACTINST` 表 |
| `dshMeta` 字段缺失 | task-local 变量 `dsh_node_meta` 未注入 | 排查 `DshTaskListener` 在 create 是否执行成功（查引擎日志）；历史任务查询时 `includeTaskLocalVariables` 是否生效 |
| `deleteReason` 字段缺失 | 历史实例正常完成 | 正常：正常完成的实例 `deleteReason=null`，非 null 仅出现在强制终止场景 |
