# BPMN 组件通俗教程

## 读教程前：流程定义生命周期（状态机）

Web Console 里的每一张流程图（流程定义）都有 4 个状态，状态决定你能做什么操作：

| 状态                | 含义                    | 编辑 BPMN | 保存草稿 | 校验 | 发布       | 停用 | 归档 | 启动新实例 |
| ----------------- | --------------------- | ------- | ---- | -- | -------- | -- | -- | ----- |
| **draft** 草稿      | 刚创建，还没部署              | ✅       | ✅    | ✅  | ✅        | ❌  | ✅  | ❌     |
| **published** 已发布 | 已部署到 Flowable，可能正在跑实例 | ✅       | ✅    | ✅  | ✅（覆盖旧版本） | ✅  | ✅  | ✅     |
| **disabled** 已停用  | 暂停使用，不接收新实例           | ✅       | ✅    | ✅  | ✅（恢复并覆盖） | ❌  | ✅  | ❌     |
| **archived** 已归档  | 终态，不再使用               | ❌       | ❌    | ❌  | ❌        | ❌  | ❌  | ❌     |

状态转换图：

```
draft ──发布──► published ──停用──► disabled ──重新发布──► published
  │                │              │
  └───────────────┘              └──────► archived ◄──────┘
  （重新发布也会回到 published）          （终态，不可再变）
```

# 第一部分：任务类组件

## 1. Service Task 服务任务

是什么：像一个自动售货机——投币、按按钮、掉饮料，全程不需要人参与。流程走到这一步，程序自动执行，做完立刻走下一步。

什么时候用：不需要人判断、机器自己就能完成的事。比如自动发邮件、自动查数据库、自动算分。

DEMO：学生提交请假单后，系统统统自动给班主任发一条提醒消息统统，不需要任何人点按钮。

```
(开始) → [填请假单] → [自动发提醒(服务任务)] → [班主任审批] → (结束)
```

自定义 JavaDelegate —— 以 `sendReminderDelegate` 为例。新建文件 `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/SendReminderDelegate.java`：

```java
package com.dsh.flowable.delegate;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 给班主任发请假提醒的自动节点委托。
 * BPMN 中通过 flowable:delegateExpression="${sendReminderDelegate}" 引用。
 */
@Component("sendReminderDelegate")   // ← 登记 Bean 名,注意别和类名混了
public class SendReminderDelegate implements JavaDelegate {  // ← 实现 Flowable 的接口

    private static final Logger log = LoggerFactory.getLogger(SendReminderDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        // 1. 从"记事卡"读上游节点写的数据
        String studentName = (String) execution.getVariable("studentName");
        Object days = execution.getVariable("days");
        String reason = (String) execution.getVariable("reason");

        // 2. 拼提醒内容
        String message = String.format(
            "【请假提醒】%s 提交了 %s 天请假申请,事由:%s,请及时审批。",
            studentName, days, reason);

        // 3. 发送。演示用日志代替;真实系统在这里调短信/邮件/企业微信 API
        log.info("[DSH 提醒] {}", message);

        // 4. 把结果写回记事卡,下游网关/节点可以读到
        execution.setVariable("reminderSent", true);
        execution.setVariable("reminderContent", message);
    }
}
```

逐行看懂它：

| 代码                                            | 白话解释                                           |
| --------------------------------------------- | ---------------------------------------------- |
| `@Component("sendReminderDelegate")`          | 把这个类登记进 Spring 登记簿，广播名叫 `sendReminderDelegate` |
| `implements JavaDelegate`                     | 向引擎承诺实现这个接口——引擎只把活派给实现了它的人                     |
| `execute(DelegateExecution execution)`        | 引擎到这个节点时调用的方法；参数 `execution` 就是那张随身记事卡         |
| `execution.getVariable("days")`               | 读记事卡：上游"填请假单"节点写的请假天数                          |
| `execution.setVariable("reminderSent", true)` | 往记事卡写字：提醒已发出（写回后下游可用）                          |
| `log.info(...)`                               | 真实系统把这一行换成调短信 / 邮件 API 的代码即可                   |

再举一个例子：审批通过后往企业微信群里推一条消息。这次我们写一个真发 HTTP 请求的委托。

第 1 步：写 Java 类

新建 `apps/flowable-engine/src/main/java/com/dsh/flowable/delegate/SendWecomDelegate.java`：

```java
package com.dsh.flowable.delegate;

import java.util.Map;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * 往企业微信群机器人发通知的委托。
 * 企业微信"群机器人"提供一个 webhook 地址,POST 一段 JSON 即可发消息。
 * BPMN 中通过 flowable:delegateExpression="${sendWecomDelegate}" 引用。
 */
@Component("sendWecomDelegate")
public class SendWecomDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(SendWecomDelegate.class);

    /** webhook 地址从配置文件读,不写死在代码里 */
    @Value("${dsh.wecom.webhook-url}")
    private String webhookUrl;

    @Override
    public void execute(DelegateExecution execution) {
        // 1. 读记事卡
        String studentName = (String) execution.getVariable("studentName");
        Object days = execution.getVariable("days");
        String approveComment = (String) execution.getVariable("approveComment");

        // 2. 拼企业微信要求的 JSON 格式(markdown 消息)
        String content = String.format(
            "## 请假审批通过\n> 学生:**%s**\n> 天数:**%s 天**\n> 审批意见:%s",
            studentName, days, approveComment);
        Map<String, Object> body = Map.of(
            "msgtype", "markdown",
            "markdown", Map.of("content", content));

        // 3. POST 出去
        RestTemplate rest = new RestTemplate();
        ResponseEntity<String> resp = rest.postForEntity(webhookUrl, body, String.class);

        // 4. 记结果到记事卡,发失败抛异常让引擎重试
        if (resp.getStatusCode().is2xxSuccessful()) {
            execution.setVariable("notifySent", true);
            log.info("[企业微信] 通知已发送:{}", content);
        } else {
            throw new IllegalStateException("企业微信发送失败:HTTP " + resp.getStatusCode());
        }
    }
}
```

逐行看懂它：

| 代码                                     | 白话解释                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `@Value("${dsh.wecom.webhook-url}")`   | 从 application.yml 里读 webhook 地址————地址是配置，不是代码——，换个群不用改代码                      |
| `Map.of("msgtype", "markdown", ...)`   | 企业微信机器人要求的消息格式：一个带 msgtype 的 JSON                                             |
| `rest.postForEntity(...)`              | 真正发 HTTP POST 的一行                                                             |
| `throw new IllegalStateException(...)` | 发失败败败故意抛异常败败——告诉引擎"这步没干成"。勾了异步执行时引擎按重试策略自动重试；不勾则事务回滚（见 1.4 节），这是和"失败就算了"的本质区别 |

第 2 步：application.yml 里加配置：

```yaml
dsh:
  wecom:
    webhook-url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人key
```

第 3 步：画布接线：Service Task → "委托表达式"填 `${sendWecomDelegate}`；要可靠投递就再勾"异步执行"、"失败重试策略"填 `R5/PT1M`（细节见 1.4 节）

第 4 步：验证：跑完审批后，看企业微信群————真收到了一条 markdown 卡片消息——。

## 2 让自动节点"动脑"——DSH backend task 节点

**是什么**：Service Task的纯自定义委托适合不动脑的活；要动脑的活（写摘要、做判断、生成内容），直接拖这个节点、在属性面板配置即可——**不用写任何 Java 代码**。它在服务器端自动调用常驻的 **DSH backend profile**（一个配好 LLM 的 DSH 实例），生成 JSON 后按输出映射写回流程变量，全程无人工参与。

画布操作：

1. palette 拖入 **DSH backend task**——`delegateExpression=${dshBackendTaskDelegate}`、`async=true`、重试策略 `R3/PT1M` 由画布一次写入，不用手填
2. 属性面板选择 **backend profile 实例**（下拉列出已注册的实例 URL）
3. 编辑 **user prompt**：变量选择器插入 `{{studentName}}`、`{{reason}}` 等占位符，文案写明输出 JSON 字段约定
4. 配 **输出映射**（outputMappings）：如 `summary → leaveSummary`、`urgency → urgency`——report 字段对到哪个上下文变量，下拉点选

两个要点：

- **写回的变量名由输出映射决定**（画布配置，不是代码）；下游网关直接写 `${leaveSummary}`、`${urgency == '紧急'}`。
- **节点扩展与 user task 同构**（userPrompt/skillRefs/outputMappings），但没有多实例、候选角色、超时升级、SoD——没有人工环节，这些语义无从谈起。

前提与配置：

- **backend profile 先启动并注册**：多实例可并存，选哪个是流程设计决策
- **引擎侧**（`application.yml`）只有轮询节奏两项：

```yaml
dsh:
  backend:
    poll-interval-seconds: 3    # 轮询backend profile 任务是否完成的时间间隔
    call-timeout-seconds: 600   # 单次任务总超时，超时走重试
```

### 失败处理（重要）

backend profile 不通、任务 failed、超时、结果解析不出 JSON 对象、输出映射违规，引擎 delegate 都会**抛异常**。节点自带 async + `R3/PT1M`（每分钟重试、共 3 次）：

- 重试期间 profile 恢复 → 下一次重试自动成功，流程继续（自愈）
- 3 次耗尽 → Job 变成死信（deadletter），流程卡住等人工干预

## 3. Receive Task 接收任务

是什么：和发通知的 Service Task 正好相反。Service Task 干完活自动走；Receive Task 走到这里会停下来休息，直到外部系统"敲门喊一声"才继续。

是什么感觉：网购后在家等快递。包裹签收（收到消息）之前，你哪儿也不去。

什么时候用：流程要等外部系统的结果，而且这个结果什么时候来不确定。比如等门禁系统确认"学生已离校"、等财务系统确认"报销款已打款"。

DEMO：请假通过后，流程停在"等宿舍系统确认离校"这一步；宿舍系统扫码确认学生出宿舍后，调用接口喊一声，流程才走到结束。

```
[班主任审批] → [等宿舍确认离校(接收任务)] ←── 外部系统调用唤醒接口推进
                     ↓ (被唤醒后)
                  (结束)
```

教程（怎么操作）：

1. 拖一个 Task，小扳手换成   Receive Task  （信封+向下箭头图标），起名"等宿舍确认离校"
2. 这个节点本身身身不需要配属性身身——属性面板只有 General + Documentation
3. 它的"钥匙"在外部系统手里
4. 画图时给它起个清楚的名字，一看就知道流程在等什么

流程怎么被"唤醒"？流程走到 Receive Task 时，引擎不往下走，也不生成待办，而是把这次执行（execution）挂起存进数据库的"运行中执行"表。外部系统要推进它，必须调 Flowable 的 `RuntimeService.trigger(executionId)`这就是"敲门"。

DEMO：给宿舍系统写一个唤醒接口，我们建一个 Controller 当"传达室"，收到 HTTP 请求后帮它去敲引擎的门。

第 1 步：新建 `apps/flowable-engine/src/main/java/com/dsh/flowable/controller/DormConfirmController.java`：

```java
package com.dsh.flowable.controller;

import java.util.Map;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.runtime.Execution;
import org.springframework.web.bind.annotation.*;

/**
 * 宿舍离校确认回调:宿舍系统扫码确认学生离校后调用本接口,唤醒等待中的流程。
 * POST /api/dorm/confirm  body: {"processInstanceId": "..."}
 */
@RestController
@RequestMapping("/api/dorm")
public class DormConfirmController {

    private final RuntimeService runtimeService;

    public DormConfirmController(RuntimeService runtimeService) {
        this.runtimeService = runtimeService;
    }

    @PostMapping("/confirm")
    public Map<String, Object> confirm(@RequestBody Map<String, String> req) {
        String processInstanceId = req.get("processInstanceId");

        // 1. 找到停在这个节点上的执行("按学号找正在等待的那个学生")
        Execution execution = runtimeService.createExecutionQuery()
            .processInstanceId(processInstanceId)
            .activityId("waitDormConfirm")     // ← 和画布上节点的 ID 一致
            .singleResult();
        if (execution == null) {
            return Map.of("ok", false, "msg", "没有找到等待中的宿舍确认节点");
        }

        // 2. 喊一声,流程复活继续走
        // Map.of(...) 里的变量会写进流程变量树,下游网关/任务都能读;
        // 这个简单 DEMO 里暂时没人读它,只是留痕。实际流程中可在后面接网关做分支判断
        runtimeService.trigger(execution.getId(), Map.of("dormConfirmed", true));

        return Map.of("ok", true, "msg", "已确认离校,流程继续");
    }
}
```

逐行看懂它：

| 代码                                                       | 白话解释                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `RuntimeService`                                         | Flowable 的"流程运行遥控器"，Spring 自动注入，不用自己 new                      |
| `createExecutionQuery()...activityId("waitDormConfirm")` | 按"节点 ID"找挂起中的执行————画布上每个节点都有 ID——（选中节点在 General 组能看到），这里填的就是它 |
| `singleResult()`                                         | 只应该有一个在等；找两个说明流程画错了，会直接报错提醒你                                  |
| `runtimeService.trigger(execution.getId(), ...)`         | 敲门动作。第二个参数是"捎带的手信"——往记事卡写 `dormConfirmed=true` 一起交给流程         |

第 2 步：画布上确认节点 ID：选中"等宿舍确认"节点，General 组里把 ID 改成 `waitDormConfirm`（好记、和代码对得上）。

第 3 步：验证：

1. 发起流程实例，走到"等宿舍确认"——流程停住，DSH 代办中心也不会有新任务（因为不是 UserTask）
2. 用 PowerShell 模拟宿舍系统喊一嗓子：

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8090/api/dorm/confirm" `
  -ContentType "application/json" `
  -Body '{"processInstanceId": "填你的实例ID"}'
```

1. 返回 `{"ok": true}`，刷新流程状态——已经走到结束了

> Receive Task vs Message 事件  ：两者都能"等外部喊一声"。区别是 Receive Task 等"无名的敲门"（trigger），Message 事件等"点名的信"（必须消息名对上）。简单等待用 Receive Task，一个流程要区分等好几种消息时用 Message 事件（见后文）。

## 4. Manual Task 手工任务

是什么：一个只写给人类看的提示，引擎完全不管它。流程走到这里直接跳过，一秒都不停。

关键区别：

| 对比项     | User Task 用户任务 | Manual Task 手工任务 |
| ------- | -------------- | ---------------- |
| 引擎生成待办吗 | 会，出现在 DSH 代办中心 | 不会               |
| 流程会停下来吗 | 停，等人处理         | 不停，直接过           |
| 用在哪     | 需要跟踪的线上任务      | 纯线下动作，只是图上标注一下   |

什么时候用：某一步是线下完成的事，系统既不派单也不关心结果。比如"学生线下到教务处盖章"、"把纸质材料放进档案袋"。

DEMO：班主任审批通过后，学生需要线下要要去教务处领出门条。这件事系统不派单、不催办，但要在图上标出来，让看流程的人知道有这一步。

```
[班主任审批] → [线下领出门条(手工任务)] → (结束)
   ↑ 引擎直接跳过这一步，只是给人看的标注
```

教程（怎么操作）：

1. 拖一个 Task，小扳手换成   Manual Task  （小手图标）
2. 不用配任何属性，起个好名字就够了（名字就是它的全部价值）
3. 常见误区：如果你希望这一步出现在 DSH 代办中心、要跟踪谁做完了——那你要的是   User Task  ，不是 Manual Task！

## 5. Script Task 脚本任务

是什么：流程走到这里，引擎当场执行一小段代码，算出的结果写到随身记事卡（流程变量）上，然后继续走。像收银员当场心算找零。

什么时候用：节点之间需要"中转加工"。比如上游节点的输出是一个嵌套 JSON，而网关条件需要的是一个简单数字——中间放一个脚本任务做转换。

DEMO：班主任审批的输出是 `output = {conclusion: "approved", comment: "同意"}`，脚本任务把它拍平成简单变量 `approvalResult = "approved"`，后面的网关条件就好写了：`${approvalResult == 'approved'}`。

```
[班主任审批] → [拍平变量(脚本任务)] → <通过?> →(是)→ ...
                     ↓
        approvalResult = "approved" 写入记事卡
```

教程（怎么操作）：

1. 拖一个 Task，小扳手换成   Script Task  （纸+笔图标），起名"拍平变量"
2. 属性面板出现   "脚本任务配置"   组：
   - 脚本语言  ：下拉选 `javascript` / `groovy` / `juel`
   - 脚本内容  ：填代码，比如 `execution.setVariable('approvalResult', output.conclusion)`
3. 保存部署，上游审批完成后变量 `approvalResult` 就出现在记事卡上了

### 写法一：juel（零依赖，推荐入门）

juel 就是 Flowable 表达式语言本尊（网关条件 `${days >= 3}` 用的就是它），引擎自带，不需要装任何东西。

画布操作：

1. 拖 Script Task，属性面板"脚本语言"填 `juel`
2. "脚本内容"写：`execution.setVariable('approvalResult', output.conclusion)`

注意：juel 里没有分号、没有 return——整段脚本就是一个表达式，算出什么就是什么。

XML 形态：

```xml
<scriptTask id="Activity_flatten" name="拍平变量" scriptFormat="juel">
  <script>execution.setVariable('approvalResult', output.conclusion)</script>
</scriptTask>
```

脚本里可以直接裸用变量名：`output.conclusion` 里的 `output` 就是上游写进记事卡的变量，引擎执行前会把整张卡"摊开"成脚本的局部变量。

适合：变量改名、取字段、简单计算。一行能写完的活儿。

### 写法二：javascript

画布操作：

1. 拖 Script Task，属性面板"脚本语言"填 `javascript`
2. "脚本内容"写：

```javascript
var conclusion = output.conclusion;
var days = output.days;

if (days >= 3) {
  execution.setVariable('approvalResult', conclusion);
  execution.setVariable('needGradeDirector', true);
} else {
  execution.setVariable('approvalResult', conclusion);
  execution.setVariable('needGradeDirector', false);
}
```

XML 形态：

```xml
<scriptTask id="Activity_flatten" name="拍平变量" scriptFormat="javascript">
  <script>
    var conclusion = output.conclusion;
    var days = output.days;
    if (days >= 3) {
      execution.setVariable('approvalResult', conclusion);
      execution.setVariable('needGradeDirector', true);
    } else {
      execution.setVariable('approvalResult', conclusion);
      execution.setVariable('needGradeDirector', false);
    }
  </script>
</scriptTask>
```

适合：有 if/for/函数等复杂逻辑，但还不够复杂到值得写 JavaDelegate。

### 写法三：groovy

画布操作：

1. 拖 Script Task，属性面板"脚本语言"填 `groovy`
2. "脚本内容"写：

```groovy
def conclusion = output.conclusion
def days = output.days

if (days >= 3) {
  execution.setVariable('approvalResult', conclusion)
  execution.setVariable('needGradeDirector', true)
} else {
  execution.setVariable('approvalResult', conclusion)
  execution.setVariable('needGradeDirector', false)
}
```

XML 形态：

```xml
<scriptTask id="Activity_flatten" name="拍平变量" scriptFormat="groovy">
  <script>
    def conclusion = output.conclusion
    def days = output.days
    if (days >= 3) {
      execution.setVariable('approvalResult', conclusion)
      execution.setVariable('needGradeDirector', true)
    } else {
      execution.setVariable('approvalResult', conclusion)
      execution.setVariable('needGradeDirector', false)
    }
  </script>
</scriptTask>
```

适合：团队里有 Groovy 基础的人；语法比 JavaScript 更接近 Java，Java 程序员上手快。

### 三种写法对比

| <br /> | juel             | javascript + GraalJS   | groovy              |
| ------ | ---------------- | ---------------------- | ------------------- |
| 要加依赖吗  | 不要  ，开箱即用        | 要（两个依赖，已预装）            | 要（一个依赖）             |
| 能干什么   | 只能算表达式，没有 if/for | 完整 JS：if/for/函数/JSON   | 完整 Groovy：if/for/闭包 |
| 语法熟悉度  | Flowable 表达式，一眼会 | 前端同学最熟                 | Java 程序员最熟          |
| 适合     | 变量改名、取字段、简单计算    | 复杂逻辑但不够写到 JavaDelegate | 团队有 Groovy 背景       |

> 判断口诀  ：
>
> - 一行能写完的用 juel
> - 要写 if/循环但逻辑不重的，用 javascript
> - 逻辑很重、要调外部 API、要复用的，别硬塞脚本——直接写 JavaDelegate（第 1.1 节），可测试、可调试、可复用

验证：部署后发起实例、完成审批，在引擎日志或 `ACT_RU_VARIABLE` 表里能看到 `approvalResult=approved` 和 `needGradeDirector=true/false`——拍平成功。

## 6. DMN 决策表 —— 查规则对照表（用 Service Task 接进流程）

是什么：像老中医看病——把"症状"输进去，查一张提前编好的规则对照表（DMN 决策表），直接得出"药方"。规则本身写在一张单独的表格里，和流程图分开维护。

为什么好：规则经常变（这学期请假 3 天找班主任，下学期改成 5 天），用决策表只需改表格，流程图一个字都不用动。

DEMO：学校有一张"请假审批层级表"：

| 请假天数   | 需要的审批层级          |
| ------ | ---------------- |
| < 3 天  | 仅班主任             |
| 3\~7 天 | 班主任 + 年级主任       |
| > 7 天  | 班主任 + 年级主任 + 教务处 |

查表节点读入 `days`，输出 `level`，后面的网关按 `level` 分流。

教程（怎么操作）：

1. 拖一个 Task，小扳手换成   Service Task，起名"决定审批层级"
2. 务实建议  ：如果规则只有两三条，直接用排他网关 + 条件表达式更简单；规则多、变得频繁时才值得上决策表

# 第二部分：网关类组件（4个菱形）—— 全是"岔路口"

> 先记住总口诀：
> 排他 = 单选题；包容 = 多选题；并行 = 全都要；事件 = 赛跑。

## 7. Exclusive Gateway 排他网关（X）—— 单选题

是什么：一个只能选一条路的岔路口。流程走到这里，挨个看出线的条件，哪条满足走哪条，其余路全部放弃。

DEMO：请假天数决定审批层级——少于 3 天只走班主任，3 天及以上加走年级主任。

```
                 ┌─(days < 3)────────→ (结束)
[填请假单] → <X>
                 └─(days >= 3)→ [年级主任审批] → (结束)
```

教程（重点，请完整看）：

1. 拖一个   Exclusive Gateway  （带 X 的菱形）到"填请假单"后面，连上箭头
2. 从网关拉出两条出线（点网关，拖它边缘的箭头）
3. 点选第一条线，右侧出现   "Flowable 条件表达式"   组，填：
   `${days < 3}`
4. 点选第二条线，同样方式填：
   `${days >= 3}`
5. 强烈建议  ：点选网关本身，在   "网关配置"   组的"默认流"下拉里选一条兜底路。这样万一两条条件都没满足（比如 `days` 忘了填），走默认路而不是直接报错
6. 规则  ：默认流那条线自己不能再填条件（BPMN 规范要求）

避坑：

- 两条线条件写得重叠（都写 `days >= 0`）→ 引擎选先定义的那条，结果随机
- 所有条件都不满足又没设默认流 → 部署时能过，运行时直接报错卡死

## 8. Inclusive Gateway 包容网关（O）—— 多选题

是什么：符合条件的路都可以走，可能走 1 条，也可能同时走 3 条，但至少走 1 条。

和排他网关的区别：排他是单选题只选一个；包容是多选题，符合的都选。

DEMO：请假时长不同，需要同时办的手续不同——请假 3 天以上要医务室证明，请假 7 天以上还要家长签字。一个学生请假 10 天，两条手续续续同时续续进行。

```
                    ┌─(days >= 3)──→ [办医务室证明] ──┐
[填请假单] → <O>    │                                ├→ <O 汇聚> → (结束)
                    └─(days >= 7)──→ [家长签字] ──────┘
```

注意右边的汇聚包容网关：它会等所有实际走过的分支都到齐才继续。请假 10 天 = 等两个分支都完成；请假 5 天 = 只等医务室那一个。

教程（怎么操作）：

1. 拖   Inclusive Gateway  （带 O 的菱形）作为分叉点，拉出多条出线
2. 每条出线  都要填条件表达式（操作同第8节第 3 步：选中线，右侧填）
3. 拖第二个包容网关作为汇聚点，把各分支的终点都连到它
4. 至少保证一条条件能成立，或给网关设默认流兜底，否则运行时报错

## 9. Parallel Gateway 并行网关（+）—— 全都要

是什么：分身术。走到这里，所有出线无条件全部同时激活。不用填任何条件——填了也没用，全部都走。

和包容网关的区别：包容网关按条件决定走哪几条（可能只走 1 条）；并行网关不看条件，每条都走。

DEMO：请假必须班主任和家长两个人都同意。两人同时收到任务，各自审批（谁先谁后无所谓），都完成后流程才继续。

```
                     ┌─→ [班主任审批] ──┐
[填请假单] → <+>     │                 ├→ <+ 汇聚> → <都同意?> → ...
                     └─→ [家长确认] ────┘
```

教程（怎么操作）：

1. 拖   Parallel Gateway  （带 + 的菱形）作为分叉点，拉出 N 条出线（不填条件）
2. 各分支干完活后，连到第二个并行网关（汇聚点）
3. 汇聚点的规则：所有入线都到齐才放行。上面 DEMO 里两人都批完，流程才继续往下走

避坑：

- 分了叉忘画汇聚点 → 流程永远走不完
- 出线上填条件是无效操作，别白费劲

重要：并行网关 ≠ 会签！

很多人想"5 个评委都要审批"就画 5 条并行分支——错。5 个评委是同一件事干 5 遍，标准做法是一个任务 + 多实例。并行网关是"""几件不同的事""同时干"。判断口诀：同一任务多人干 → 多实例；不同任务同时干 → 并行网关。

## 10. Event-based Gateway 事件网关 —— 赛跑

是什么：几条出线各派一名选手起跑，谁先冲线走谁的路，其余选手全部退场。

特点：出线不能连普通任务，只能连\*\*"捕获型事件"\*\*（Timer 中间事件 / Message 中间事件 / Receive Task）——因为"选手"必须是会等东西的节点。

DEMO：请假单发给家长后——要么 24 小时内家长回复同意（消息先到），要么 24 小时超时（闹钟先响）自动驳回。谁先发生走谁，另一个作废。

```
                          ┌─(消息事件: 家长回复)─→ [继续审批流程]
[发家长确认] → <事件网关> │
                          └─(定时事件: PT24H)────→ [自动驳回] → (结束)
```

教程（怎么操作）：

1. 拖   Event-based Gateway  （菱形里有个五边形事件图标）
2. 拉两条出线，每条连一个中间捕获事件：
   - 拖一个空白中间事件连上，点节点旁小扳手换成   Timer   类型，属性面板的 Timer 组里选"持续时间"，填 `PT24H`（24 小时）
   - 另一条连一个空白中间事件，小扳手换成   Message   类型，填消息名如 `parentReply`
3. 谁先触发，流程走谁的分支，另一条自动作废

机制：流程走到事件网关时，引擎给每条出线建一个"等待席"（事件订阅）：Timer 席由引擎的定时器线程盯着表，Message 席等着外部点名。任何一个先被触发，引擎立刻注销其余所有等待席——这就是"其余选手退场"的实现。

"家长回复"这封信谁投递？家长在手机上点"同意"后，你的系统要替TA发消息。代码只需要两步（可以放进任意 Controller，比如家长回调接口里）：

```java
// 1. 找到正在"等家长回复"席上的执行
Execution execution = runtimeService.createExecutionQuery()
    .processInstanceId(processInstanceId)
    .messageEventSubscriptionName("parentReply")   // ← 和画布上填的消息名一致
    .singleResult();

// 2. 点名投递,带上家长的选择
if (execution != null) {
    runtimeService.messageEventReceived(
        "parentReply",
        execution.getId(),
        Map.of("parentResult", "approved"));   // 随信附的内容,写进记事卡
}
```

| 代码                                            | 白话解释                                         |
| --------------------------------------------- | -------------------------------------------- |
| `messageEventSubscriptionName("parentReply")` | 按"等待席"的名字找——就是画布上 Message 组里填的那个名字           |
| `messageEventReceived(...)`                   | 投递动作：这个席位命中，流程走这条线                           |
| `Map.of("parentResult", "approved")`          | 随信内容，下游网关直接用 `${parentResult == 'approved'}` |

Timer 选手那边什么都不用做——引擎的定时器线程自己盯着表，到点自动"冲线"。

和排他网关的本质区别：排他网关是"看条件选路"（条件此刻就能算出来）；事件网关是"看未来谁先发生"（此刻算不出来，只能等）。能用条件决定的别用事件，必须等结果的才用事件。

验证实验：发起实例后故意不做任何操作，把 Timer 的 `PT24H` 临时改成 `PT1M`（1 分钟）——一分钟后流程自动走"自动驳回"线；再发起一个实例并立刻调上面的投递代码——走"家长回复"线，且定时器等待席被注销（等再久也不会驳回）。

## 11 多实例（一）ServiceTask：按数组元素复制，批量处理

多实例 = 让同一个任务自动复制 N 份，再用完成条件提前收工（达到条件，剩余份数作废）。DSH 三种任务节点共用这一套机制，本教程拆成三节、一种节点一节，差别只在**份数（N）从哪来**：

- **普通 ServiceTask（定制 delegate）**（本节）：N = 集合变量的数组长度——批量处理（如 100 张发票各识别一遍）。
- **人工节点（UserTask）**（第 12 节）：N = 候选角色的成员数，每人一条待办——单人 / 会签 / 串签 / 计票。
- **DSH backend task**（第 13 节）：N = profile 列表行数——多 AI 并行（如 3 个不同 LLM 配置各评审一遍、2 票通过即走）。

本节先讲三种节点共用的部分（画布操作、份数总表、内置数数变量、组合速查、红线），中间讲 ServiceTask 自己的集合形式。

### 画布操作：三种节点完全一样

1. 拖一个任务节点。
2. 点节点旁的小扳手。注意：Multi-instance 在弹出菜单最顶上横排的三个小图标里（图标本身没有文字，鼠标悬停会显示英文提示）：
   | 位置 | 图标       | 悬停提示                      | 作用                                                                                  |
   | -- | -------- | ------------------------- | ----------------------------------------------------------------------------------- |
   | 最左 | 三条竖线 ▮▮▮ | Parallel multi-instance   | 并行多实例：N 份同时开始（人工节点=成员同时收到待办；自动节点=N 份同时执行）                                           |
   | 中间 | 三条横线 ≡   | Sequential multi-instance | 顺序多实例：一份做完再做下一份（自动节点逐份执行，对限流的外部接口友好）                                                |
   | 最右 | 循环箭头 ↻   | Loop                      | 标准循环：**不是多实例**——同一份任务反复执行直到条件不满足；**任务节点（人工与自动）均已隐藏此图标**，DSH 不支持循环重做，手改 XML 会被发布校验拒绝 |
   点图标后任务右上角出现小竖线——变身成功（再点一次可取消）。
3. 切成多实例后，DSH 面板出现对应的多实例配置（各节点可填什么见下文）。

### 份数总表：三种任务节点

| 节点类型                     | 份数怎么定                                         | Loop cardinality                                            | 完成条件                                                                      |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| UserTask（人工）             | 候选角色成员数（引擎运行时查角色注入）                           | **不允许**（面板隐藏；手改 XML 发布校验直接拒绝——计数形式会让引擎放弃自动派发，任务无人办理）        | 可选：单人填 `${nrOfCompletedInstances >= 1}`，会签留空，配 votingRule 时自动生成           |
| DSH backend task         | **profile 列表行数**（属性面板增删行自动同步 loopCardinality） | 由列表行数维护（面板不直接编辑数字）                                          | 可选，如 3 个 AI 里 2 个完成即走 `${nrOfCompletedInstances >= 2}`；配 votingRule 时自动生成 |
| ServiceTask（定制 delegate） | **集合变量**的数组长度（collection 选已声明的 array 变量）      | **不允许**（集合形式专用；手改 XML 发布校验拒绝——计数形式绕开元素注入，delegate 读不到逐实例数据） | 可选，如 5 张发票收齐任意 3 份报告即走 `${nrOfCompletedInstances >= 3}`                   |

### ServiceTask：按数组元素复制（集合形式）

ServiceTask 的多实例是**集合形式**：份数 = 已声明的 array 上下文变量的长度，引擎把数组元素逐份注入每个实例。典型场景是批量处理——数组里有 100 张发票就跑 100 份，每份识别一张。

画布操作：拖一个 ServiceTask → 扳手选并行 ▮▮▮（要一份做完再做下一份就选串行 ≡）→ DSH 面板 Multi-instance 组里把 collection 下拉选成已声明的 array 变量、elementVariable 填元素变量名。选好后的 XML 形态：

```xml
<serviceTask id="ocrInvoices" name="逐张识别发票" flowable:delegateExpression="${ocrDelegate}">
  <multiInstanceLoopCharacteristics isSequential="false"
      flowable:collection="invoiceList" flowable:elementVariable="invoice">
    <completionCondition xsi:type="bpmn:tFormalExpression">
      ${nrOfCompletedInstances &gt;= 3}
    </completionCondition>
  </multiInstanceLoopCharacteristics>
</serviceTask>
```

- `flowable:collection="invoiceList"`：已声明的 array 上下文变量（面板下拉只能选它），实例数=数组长度，运行时数组里有几个元素就跑几份。
- `flowable:elementVariable="invoice"`：引擎把当前元素注入每个实例——**Java delegate 里** **`execution.getVariable("invoice")`** **读到的就是当前这一份**。这个名字必须和 Java 代码里读取的变量名一致（教程约定），且不能与已声明的上下文变量重名（实例内会遮蔽流程变量，发布校验拒绝）。
- 收齐任意 3 份即放行（早收后剩余实例自动跳过）。注意这里的语义是"**完成数量**"——如果 5 份是"同意/拒绝"的**表决**，数完成数不够（3 人里可能 1 同意 2 拒绝），请用会签计票 votingRule（三种任务节点通用：userTask 详见第 12 节，backend task 详见第 13 节）。
- ServiceTask 的计票票源是 **delegate 代码** **`setVariable`** **写入的表决变量**：普通 ServiceTask 没有输出映射，面板的表决变量下拉改为列**已声明的上下文变量**——代码写什么静态查不了，只能要求先声明（计票机制详见第 12 节）。

### 引擎内置的"数数变量"

引擎创建每个多实例节点时就把这些计数变量 `setVariable` 写进执行上下文，完成条件表达式里直接用：

| 变量                       | 含义                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `nrOfInstances`          | 一共几份                                                                                    |
| `nrOfActiveInstances`    | 还在进行中的几份（并行模式 = 还没交卷的份数；顺序模式恒为 1）                                                       |
| `nrOfCompletedInstances` | 已经完成的几份                                                                                 |
| `loopCounter`            | 当前这份的序号，从 0 开始（第 1 份的 `loopCounter=0`）——给它派活时常用，如 `${judges[loopCounter]}` 把名单数组按序号一人一个 |

常用完成条件：全部完成才放行 `${nrOfCompletedInstances == nrOfInstances}`；任意 N 份 `${nrOfCompletedInstances >= N}`。

### 组合速查:多实例形态 × 计票字段 × 完成条件

votingRule 的四个字段与完成条件的分工:**表决变量 + 通过值**定义"一张票怎么读"(值=通过值→同意票;非空且不等→否决票);**通过票数 / 否决票数**是收票阈值,引擎把它们编译成自动完成条件;**完成条件**配了 votingRule 就不归你管(面板隐藏、手写被发布校验拒绝),不配 votingRule 时才手写(字段含义见第 12 节「会签计票」)。与扳手菜单三种形态的组合:

| 扳手选择   | votingRule | 完成条件                                                     | 行为                                                            | 典型场景                            |
| ------ | ---------- | -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| 并行 ▮▮▮ | 不配         | 留空                                                       | 全员/全部实例完成才放行                                                  | 会签(全员核实登记表)、全量批处理               |
| 并行 ▮▮▮ | 不配         | `${nrOfCompletedInstances >= 1}`                         | 任一完成即收,其余待办/实例自动删除                                            | 单人(值班员处理工单)、镜像源任一成功             |
| 并行 ▮▮▮ | 配          | 自动生成(`${dsh_passCount_x >= P[或]dsh_rejectCount_x >= R}`) | 同意票/否决票达阈值提前收,剩余待办/实例自动删除                                     | **5 人中 3 人同意 / 3 个 AI 中 2 个通过** |
| 串行 ≡   | 不配         | 留空                                                       | 逐份办理(前一份完成后下一份才收到/执行)                                         | 串签(层级递审)、限流接口逐张调                |
| 串行 ≡   | 配          | 自动生成(同上)                                                 | 按顺序逐份投票,投够阈值即收,后面的份不再收到/执行                                    | 逐级投票、够票即走                       |
| 循环 ↻   | —(无关)      | 循环条件(loop condition)                                     | **不是多实例**:同一份任务反复执行直到条件不满足;任务节点(人工与自动)均已隐藏循环图标,手改 XML 被发布校验拒绝 | DSH 任务节点不支持                     |

上面五行对三种任务节点都成立(并行/串行、留空/完成条件/计票是共同机制),差别只在"份数从哪来"(见本章开头的三种任务节点表)。**backend task 多实例的典型组合就是"并行 + votingRule"——多 AI 会诊(示例见第 13 节)**;ServiceTask 批处理则常配"并行 + `${nrOfCompletedInstances >= N}`"(收够 N 份即走)。

四条组合红线(发布校验直接拒绝):**votingRule 与手写 completionCondition 并存**(完成条件由计票规则生成);**UserTask / ServiceTask 配 loopCardinality**(DSH 派发只认"按角色成员/按数组元素复制",计数形式绕开注入机制);**backend task 多实例的 profile 列表行数 ≠ 实例数**(增删列表行会自动同步);**任何任务节点配标准循环(standardLoopCharacteristics)**(不支持循环重做)。另外 votingRule 只对多实例任务成立——没配多实例的节点配了 votingRule 也会被发布校验拦下;多实例完成条件里的引用也会做存在性检查(引擎内置 `nrOf*`/`loopCounter` 变量豁免)。

串行 + votingRule 的一个细节:完成条件在每份完成后求值,串行下即"每投一票检查一次",所以语义是"按名单顺序投票,任意时刻凑够阈值即收"——名单靠前的人投票权实际更大,选串行还是并行是业务决策。

## 12 多实例（二）UserTask：按角色成员复制，多人协作

人工节点（UserTask）的多实例份数 = 候选角色的成员数：引擎运行时查角色成员，一人一份待办。责任规则只在属性面板里选"候选角色";任务到底是一个人干、所有人一起干、还是按顺序干,由 BPMN 原生多实例表达。你不需要手动写 collection、element variable 和 assignee,引擎部署时会根据候选角色自动补齐。多实例的共用机制（画布操作、数数变量、组合速查、红线）见第 11 节。

### 画布操作

1. 拖一个 UserTask,在右侧 DSH 面板里填"候选角色"(例如 `role-approver`)。
2. 点节点旁的小扳手,选择多实例类型:
   | 业务语义                           | 扳手选择         | Multi-instance 组填写                                     |
   | ------------------------------ | ------------ | ------------------------------------------------------ |
   | **单人**(角色里任意一人完成即可,其他人的待办自动消失) | 三条竖线 ▮▮▮(并行) | Completion condition: `${nrOfCompletedInstances >= 1}` |
   | **会签**(角色里所有人都要完成)             | 三条竖线 ▮▮▮(并行) | Completion condition: 留空                               |
   | **串签**(角色里的人依次完成)              | 三条横线 ≡(串行)   | Completion condition: 留空                               |
3. Loop cardinality 不用填,实例数由候选角色成员数决定——DSH 属性面板的多实例组对人工节点已隐藏该输入框;手改 XML 写了 loopCardinality 会被发布校验直接拒绝(计数形式会让引擎放弃自动补齐 collection,任务将无人办理)。

### 引擎帮你做了什么

部署时,`DshBpmnParseHandler` 会自动把这个 userTask 补成下面的样子(你不必手动写):

```xml
<userTask id="approveTask" name="审批" flowable:assignee="${dshCandidateUserId}">
  <extensionElements>
    <dsh:assignmentRule candidateRoleId="role-approver"/>
  </extensionElements>
  <multiInstanceLoopCharacteristics isSequential="false"
      flowable:collection="${dsh_candidates_approveTask}"
      flowable:elementVariable="dshCandidateUserId">
    <completionCondition xsi:type="bpmn:tFormalExpression">
      ${nrOfCompletedInstances &gt;= 1}
    </completionCondition>
  </multiInstanceLoopCharacteristics>
</userTask>
```

三个字段的白话对照:`flowable:collection` 告诉引擎"照着哪个变量复制任务"(必须是带 `${}` 的表达式);`flowable:elementVariable` 是"每个实例里当前成员存到哪个变量"(引擎逐份把成员 user.id 放进 `dshCandidateUserId`);`flowable:assignee` 用这个变量直接指定办理人。

运行时,进入该节点前 `DshMultiInstanceSetupListener` 会:

1. 查 `public.app_memberships` 拿到 `role-approver` 下的成员 user.id 列表;
2. 如有 SoD 规则(如排除申请人),先过滤;
3. 把结果写入流程变量 `dsh_candidates_approveTask`。

Flowable 再按这个变量为每个成员生成一个任务实例,并直接把 `assignee` 设为对应成员,**不需要认领**。

### 常见误区

- **Loop cardinality 不用填**:角色有几个人就生成几份,手动写数字会写死,成员变动时还得改流程图。发布校验会拒绝人工节点配 loopCardinality。
- **单人不是"不设置多实例"**:不设置多实例只会产生一条任务,并且默认要走认领;单人必须设置并行多实例 + 完成条件,才能实现"一人完成、其余自动作废"。发布校验会拒绝"配了候选角色但没有多实例"的人工节点。
- **会签和串签的区别只在并行/串行**:两者都是所有人完成才放行,前者同时收到待办,后者按顺序收到。

### 会签计票 (votingRule):按表决结果收工,而不是按完成数量

上面的会签语义是"所有人都投完才放行"。但真实业务常是"**5 个人里 3 个人同意才能往下走**"——只数"完成了几份"(`nrOfCompletedInstances >= 3`)不够:1 人同意 2 人拒绝也算 3 份完成,照样收工,与业务需求不符。每份提交写同一个结果变量还会互相覆盖,网关只能看到"最后一个人"的结果。

`dsh:votingRule` 解决这个问题,配置在会签节点的 DSH 面板「会签计票」:

| 配置       | 业务含义                          | 例          |
| -------- | ----------------------------- | ---------- |
| 表决变量     | 每人提交时"表达意见"写在哪个输出映射 target 变量 | `approved` |
| 通过值      | 变量取该值记一票**同意**;非空且不等记一票**否决** | `true`     |
| 通过票数     | 同意票凑够几票**提前放行**,剩余待办自动删除      | `3`        |
| 否决票数(可选) | 否决票凑够几票**提前毙掉**;留空=投满后由网关判    | `2`        |

引擎行为:每份提交时按值累加 `dsh_passCount_<节点id>` / `dsh_rejectCount_<节点id>`;完成条件由引擎部署时自动生成(配了 votingRule 的节点,多实例组的完成条件输入框被隐藏,手写会被发布校验拒绝):

```xml
<userTask id="approve" flowable:assignee="${dshCandidateUserId}">
  <extensionElements>
    <dsh:assignmentRule candidateRoleId="..."/>
    <dsh:votingRule variable="approved" passValue="true" passCount="3" rejectCount="2"/>
    <dsh:outputMappings>
      <dsh:mapping source="approved" target="approved"/>
    </dsh:outputMappings>
  </extensionElements>
  <multiInstanceLoopCharacteristics isSequential="false"/>
  <!-- 无需手写 completionCondition:引擎生成
       ${dsh_passCount_approve >= 3 || dsh_rejectCount_approve >= 2} -->
</userTask>
```

走查(5 人角色,passCount=3, rejectCount=2):同意、拒绝、同意 → passCount=2 未达标,继续等;再一份同意 → passCount=3 提前收,第 5 人待办自动删除;两份拒绝 → rejectCount=2 提前收。多人投满仍未达 3 票同意 → 自然结束,由后续**排他网关**按票数路由:

```xml
<sequenceFlow id="pass" sourceRef="decide" targetRef="...">
  <conditionExpression xsi:type="bpmn:tFormalExpression">${dsh_passCount_approve >= 3}</conditionExpression>
</sequenceFlow>
<sequenceFlow id="reject" sourceRef="decide" targetRef="...">
  <conditionExpression xsi:type="bpmn:tFormalExpression">${dsh_passCount_approve < 3}</conditionExpression>
</sequenceFlow>
```

约束(发布校验保证)：表决变量必须是本节点输出映射 target 之一（保证计票读的变量一定在提交里，先声明为上下文变量）；votingRule 节点必须配多实例；员工在提交对话框清空表决映射 → 该份不计票、不阻断提交。

**三种任务节点通用**：计票机制与完成条件的生成本节讲的是 userTask 形态（票来自员工提交映射）；DSH backend task 的票来自 delegate 输出映射写入的表决变量（第 13 节），普通 ServiceTask 的票来自 delegate 代码 `setVariable` 写入的已声明上下文变量（第 11 节）。"5 人里 3 人同意"与"3 个 AI 里 2 个通过"是同一个语义。

## 13 多实例（三）DSH backend task：按 profile 列表复制，多 AI 并行

单实例的 DSH backend task 是"一个节点调一个 backend profile 跑一次 AI 会话"（基础用法见第 2 节）。多实例把它变成**多 AI 并行**：N 个 backend profile 各跑一遍，典型场景是"多 AI 会诊"——3 个不同 LLM 配置各评审一遍、2 票通过即走。

与 user task 一样用并行/串行多实例表达，唯一区别是份数不来自候选角色成员数，而来自设计时显式配置的 profile 列表。

### 画布操作

1. 拖一个 DSH backend task（基础配置见第 2 节：profile 下拉、userPrompt、skillRefs、输出映射）。
2. 点节点旁的小扳手选多实例形态（并行 ▮▮▮ / 串行 ≡，共用操作见第 11 节）。
3. 切成多实例后，属性面板的 profile 下拉自动变为 **profile 列表编辑**：一行一个 profile URL，第 i 行对应第 i 个实例；增删行时实例数自动同步（loopCardinality 由列表行数维护，面板不直接编辑数字）。单实例的 profile 下拉与多实例列表互斥，两者并存会被发布校验拒绝。

多 AI 会诊示例（3 个 profile 各评审一遍，2 票通过即走）：

```xml
<serviceTask id="aiReview" name="多 AI 会诊" flowable:delegateExpression="${dshBackendTaskDelegate}"
             flowable:async="true" flowable:failedJobRetryTimeCycle="R3/PT1M">
  <extensionElements>
    <dsh:backendTask>
      <dsh:backendProfile url="http://backend-1:3081"/>
      <dsh:backendProfile url="http://backend-2:3081"/>
      <dsh:backendProfile url="http://backend-3:3081"/>
    </dsh:backendTask>
    <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
    <dsh:outputMappings>
      <dsh:mapping source="approved" target="approved"/>
    </dsh:outputMappings>
  </extensionElements>
  <multiInstanceLoopCharacteristics isSequential="false">
    <loopCardinality>3</loopCardinality>
  </multiInstanceLoopCharacteristics>
</serviceTask>
```

运行时走查：第 1/2/3 个实例（`loopCounter` = 0/1/2）分别绑定第 1/2/3 个 profile URL（想多个实例绑同一个 profile 就重复选同一行）；每个实例提交同一个 userPrompt（各自插值）、各自产出 JSON 并按 outputMappings 写入流程变量；async 任务逐实例重试互不影响。

计票：backend task 的票来自 **delegate 输出映射写入的表决变量**——每个实例的 result JSON 各自映射一次，表决变量下拉同样只列输出映射 target；计数与完成条件生成与 user task 完全一致（机制见第 12 节「会签计票」）。上面的示例就是"3 个 AI 中 2 个通过"的完整形态。

发布校验要点（backend task 多实例专属）：profile 列表非空且行数 = 实例数（增删行自动同步，手改 XML 改崩会被拒绝）；列表每个 URL 必须已注册且活跃（逐行查注册表）；单实例 profile 属性与多实例列表互斥；标准循环拒绝。另外 backend profile 的 skill 归属聚合会把列表逐行展开——每个 URL 各自同步列表所在节点的 skillRefs。

# 第三部分：事件类组件

> 事件 = 流程图上的圆圈，按位置分三种：
>
> - 开始事件（细线圆圈）：流程的起点，一张图可以有多个（比如"收到邮件开始"和"定时开始"两种触发方式）
> - 中间事件（双线圆圈）：流程走到中间突然停下等某事发生，或主动做一件事
> - 结束事件（粗线圆圈）：流程的终点，走到这里这条流程就结束了
>
> 另外还有边界事件（贴在任务方框边缘的圆圈）：它不是独立的位置，而是附在任务身上的"中断入口"——任务正在执行（比如等人审批），中间如果发生了某件事（比如超时、收到消息），就从边界事件这条岔路走另一条路。
>
> 中间事件分捕获型（空心，停下来等某事发生）和抛出型（实心，主动做某事如抛信号/补偿）；开始事件和边界事件只有捕获型，结束事件本质是抛出型（走到终点抛出结果）。

***

## 14. Start Event 开始事件 —— 流程的起点

是什么：流程图最前面的细线圆圈，表示"流程从这里开始"。像跑步比赛的起跑线——枪一响，选手出发。

什么时候用：任何需要启动一个流程实例的时候。最常见的是"有人提交申请就启动"，也可以是"每天早上 8 点自动启动"或"收到系统消息时启动"。

DEMO：学生点"提交请假单"按钮，流程开始。

```
○ → [填请假单] → [班主任审批] → ◉
↑
起点（Start Event）
```

教程：

1. 从左侧调色板拖一个个个圆圈个个（Start Event）到画布最左边
2. 用箭头连到第一个任务（如"填请假单"）
3. 属性面板只有 General + Documentation，不需要配置任何属性

> 默认的 Start Event 是"空启动"--只要调用 `runtimeService.startProcessInstanceByKey("流程key")` 就启动。如果要从外部消息/定时器触发，点小扳手换成具体类型（见下面的 Start Event 变型速查表）。
>
> 启动时可以传变量，比如申请人 ID、请假天数等，传入后直接成为流程实例的根级流程变量，后续所有节点都能读到：
>
> ```java
> // 启动时传入变量 Map
> Map<String, Object> vars = Map.of("applicant", "张三", "days", 5);
> runtimeService.startProcessInstanceByKey("leaveApproval", vars);
> ```

深入：Start Event 的 5 种变型（小扳手切换）

| 变型          | 图标    | 什么时候用            | DSH 场景                         |
| ----------- | ----- | ---------------- | ------------------------------ |
| None（默认）    | 细线圆圈  | 程序代码直接启动         | 前端调后端 API 启动                   |
| Timer       | 圆圈+时钟 | 定时自动启动           | 每天早上 8 点自动生成"日报汇总"待办           |
| Message     | 圆圈+信封 | 收到特定消息后启动        | 收到企业微信的"入职审批"消息后自动启动           |
| Signal      | 圆圈+三角 | 收到全局信号后启动        | 全校广播"放假通知"后，所有监听该信号的流程启动       |
| Conditional | 圆圈+文件 | 仅限事件子流程内，条件为真时触发 | 库存监控流程中 stock < 100 时触发紧急补货子流程 |

操作：选中 Start Event -> 点小扳手 -> 选具体类型 -> 属性面板出现对应配置组（如 Timer 组填定时规则）。

### 14.1 Timer Start Event -- 定时启动

DEMO：每天早上 8 点自动生成"日报汇总"待办，不需要人手动触发。

```
⏰(每天8:00) -> [生成日报汇总] -> [主管审阅] -> ◉
↑
Timer Start Event
```

XML 形态：

```xml
<startEvent id="dailyReportStart">
  <timerEventDefinition>
    <timeCycle>0 0 8 * * ?</timeCycle>
  </timerEventDefinition>
</startEvent>
```

触发方式：引擎后台 JobExecutor 自动计时，到点自动创建新实例。不需要任何代码调用。

### 14.2 Message Start Event -- 收到消息启动

DEMO：企业微信收到"入职审批"消息后自动启动入职流程。

```
✉️(收到 onboardRequest) -> [录入员工信息] -> [HR审批] -> ◉
↑
Message Start Event
```

XML 形态：

```xml
<startEvent id="onboardStart">
  <messageEventDefinition messageRef="onboardRequest" />
</startEvent>
```

触发方式：

```java
// 外部系统收到企业微信回调后投递消息，引擎匹配到同名 Message Start Event 自动启动新实例
runtimeService.startProcessInstanceByMessage("onboardRequest");
```

### 14.3 Signal Start Event -- 收到信号启动

DEMO：全校广播"放假通知"信号后，监听该信号的流程自动启动。

```
📡(收到 holidayNotice) -> [执行放假流程] -> ◉
↑
Signal Start Event
```

XML 形态：

```xml
<startEvent id="holidayStart">
  <signalEventDefinition signalRef="holidayNotice" />
</startEvent>
```

触发方式：

```java
// 广播信号后，引擎找到所有监听该信号的 Signal Start Event，各启动一个新实例
runtimeService.signalEventReceived("holidayNotice");
```

> Signal 和 Message 的区别：Signal 是广播，一个信号能同时启动所有监听它的流程定义（含多个）；Message 是点对点，一条消息只匹配一个流程定义的 Message Start Event。

### 14.4 Conditional Start Event -- 条件为真启动

> 注意：Conditional Start Event 只能用在事件子流程（triggeredByEvent="true"）里，不能作为流程定义的顶级开始事件。条件里的变量来自外层流程实例的流程变量--流程还没启动的话，变量无从谈起。

DEMO：在一个"库存监控"流程实例运行过程中，当流程变量 stock 降到 100 以下时，事件子流程的 Conditional Start Event 触发，启动"紧急补货"处理。

```
[库存监控(主流程)]
  └─ 📋(stock < 100) -> [紧急补货] -> ◉
     ↑
     Conditional Start Event（事件子流程内）
```

XML 形态：

```xml
<!-- 事件子流程:triggeredByEvent="true" 表示由事件触发,不是正常流程顺序进入 -->
<subProcess id="replenishSubProcess" triggeredByEvent="true">
  <startEvent id="condStart">
    <conditionalEventDefinition>
      <condition>${stock < 100}</condition>
    </conditionalEventDefinition>
  </startEvent>
  <sequenceFlow sourceRef="condStart" targetRef="replenishTask" />
  <serviceTask id="replenishTask" flowable:expression="${replenishService.trigger()}" />
  <endEvent id="endReplenish" />
</subProcess>
```

触发方式：引擎在流程实例的变量变化时评估条件，为 true 则在当前实例内部启动子流程。

```java
// 在库存监控流程实例中设置变量,触发条件评估
runtimeService.setVariable(executionId, "stock", 80);
```

> 如果要"库存低于阈值就启动一个全新的补货流程"，不要用 Conditional Start Event--应该由外部系统检测到阈值后直接调用 `runtimeService.startProcessInstanceByKey("replenishProcess")`。

***

## 15. End Event 结束事件 —— 流程的终点

是什么：流程图最后面的粗线圆圈，表示"到这里流程就彻底结束了"。像跑步比赛的终点线——冲线后比赛结束，所有人散场。

什么时候用：流程的所有分支最终都要汇聚到一个或多个 End Event。一个流程图可以有多个结束点（比如"审批通过"和"审批驳回"两个结束）。

DEMO：请假审批完成，流程结束。

```
○ → [填请假单] → [班主任审批] → ◉
                                      ↑
                                    终点（End Event）
```

教程：

1. 从左侧调色板拖一个个个粗线圆圈个个（End Event）到画布
2. 用箭头把流程的最后一步连到它上面
3. 属性面板只有 General + Documentation，，，默认不需要配置，，

> End Event 只是一个"正常结束"标记。如果流程执行到这里，引擎会清理相关资源、归档历史数据。但如果希望结束时主动做点什么时时（比如发个通知、抛个错误），点小扳手换成具体类型。

深入：End Event 的 7 种变型（小扳手切换）

| 变型           | 图标        | 什么时候用                  | DSH 场景                              |
| ------------ | --------- | ---------------------- | ----------------------------------- |
| None（默认）     | 粗线圆圈      | 正常结束，什么都不做             | 最常见的结束方式                            |
| Message      | 粗线圆圈+信封   | 结束时主动发一条消息             | 请假审批结束时，发消息通知学生"已批准"                |
| Signal       | 粗线圆圈+三角   | 结束时发一个全局信号             | 请假流程结束，广播信号触发"考勤系统更新"               |
| Error        | 粗线圆圈+闪电   | 以错误状态结束                | 发现严重违规（如伪造请假理由），以 Error 结束并触发错误处理流程 |
| Escalation   | 粗线圆圈+向上箭头 | 结束时向上升级                | 班主任发现需要校长介入，以 Escalation 结束并触发升级流程  |
| Compensation | 粗线圆圈+回退箭头 | 结束时触发补偿（撤销操作）          | 审批通过后发现问题，触发补偿回滚已执行的操作              |
| Terminate    | 粗线圆圈内加叉   | 立刻终止整个流程实例  （包括所有并行分支） | 紧急取消——学生撤销请假申请，整个流程立即终止，不管进行到哪一步    |

特别注意 Terminate：其他 End Event 只结束当前分支，并行分支继续跑；Terminate 像按下"总电源开关"，整个实例瞬间停止。DSH 场景中，如果用户点击"撤销申请"，应该用 Terminate End Event。

操作：选中 End Event → 点小扳手 → 选具体类型 → 属性面板出现对应配置（如 Message 组填消息名）。

***

## 16. Timer Intermediate Catch Event 定时中间捕获事件 —— 等闹钟到点

是什么：流程走到这里停下来等一个时间点，到了才继续。像设了一个闹钟——铃响之前什么都不做，铃响后立刻起床。

什么时候用：需要暂停流程到某个时刻再继续的场景。比如"寒暑假期间暂停审批，开学后继续"、"订单 24 小时后自动确认"。

DEMO：学生 7 月 1 日提交请假单，但学校放假到 9 月 1 日，流程停到开学当天早上 8 点才继续审批。

```
[填请假单] → (⏰ 等到 2026-09-01T08:00) → [班主任审批] → ◉
                ↑
         Timer Intermediate Catch
```

教程：

1. 拖一个空白中间事件（双线圆圈）到流程中间，用箭头连入和连出
2. 点节点旁的小扳手 → 选   Timer intermediate catch event
3. 属性面板出现   Timer 组  ，有三种闹钟类型（和附录 D 对应）：
   | 类型       | 属性面板标签         | 填什么   | 例子                          |
   | -------- | -------------- | ----- | --------------------------- |
   | Date     | Timer date     | 固定时间点 | `2026-09-01T08:00:00+08:00` |
   | Duration | Timer duration | 等多久   | `PT24H`（等 24 小时）            |
   | Cycle    | Timer cycle    | 重复规则  | `R5/PT2H`（每 2 小时一次，共 5 次）   |
4. 填好后，流程走到这里会自动暂停，引擎在后台计时，到点后自动唤醒继续执行

深入：三种闹钟的选用口诀

- Date（定点闹钟）  ：等日历上的固定时刻。暑假结束、截止日期、会议开始时间。注意：如果填的时刻已经过去了，引擎不会报错，而是立刻继续——像闹钟设在昨天，今天看它已经响过了。
- Duration（倒计时器）  ：从流程走到这个节点那一刻开始倒数。限时审批（24 小时没人处理自动转下一步）、订单超时自动关闭。常用于和边界事件配合。
- Cycle（重复闹钟）  ：每隔一段时间响一次。催办提醒（每 2 小时催一次班主任，最多催 5 次）。只能配在非中断型边界事件上，配在中间事件上第一次到点流程就走了，轮不到第二次。

XML 形态：

```xml
<intermediateCatchEvent id="waitForSchoolOpening">
  <timerEventDefinition>
    <timeDate>2026-09-01T08:00:00+08:00</timeDate>
  </timerEventDefinition>
</intermediateCatchEvent>
```

***

## 17. Message Intermediate Catch Event 消息中间捕获事件 —— 等别人递信

是什么：流程走到这里停下来等一封特定的信（消息），信到了才继续。像站在传达室等快递——快递没来就等着，来了签收后才能走。

什么时候用：流程需要等待外部系统/人主动通知的场景。比如"等宿舍管理员确认床位"、"等财务系统返回付款结果"。

DEMO：学生提交请假单后，流程停在"等宿舍管理员确认离校"这一步，宿管老师在手机上点"确认"后，流程才继续到班主任审批。

```
[填请假单] → (✉️ 等宿管确认) → [班主任审批] → ◉
                ↑
      Message Intermediate Catch
```

教程：

1. 拖一个空白中间事件到流程中间
2. 点小扳手 → 选   Message intermediate catch event
3. 属性面板出现   Message 组  ：
   - Message  ：下拉选择或新建一个消息定义（给消息起个名字，如 `dormConfirmed`）
   - 这个名字就是"信的名字"，外部系统投递时必须指定同一个名字
4. 外部系统调用引擎 API 投递消息：
   ```java
   // Java 代码：宿管确认后调用
   runtimeService.messageEventReceived("dormConfirmed", executionId);
   ```
   其中 `executionId` 是流程实例在消息捕获节点处的执行 ID（通过查询活跃实例获取）。

深入：和 Receive Task（第 3 节）的区别

| <br /> | Message Intermediate Catch                 | Receive Task                          |
| ------ | ------------------------------------------ | ------------------------------------- |
| 外观     | 双线圆圈                                       | 圆角矩形（和 User Task 一样）                  |
| 语义     | "等一个信号/通知"                                 | "等一个明确的任务完成"                          |
| 属性配置   | 需要指定 Message 名字                            | 不需要配置（默认匿名唤醒）                         |
| 唤醒方式   | `messageEventReceived("消息名", executionId)` | `runtimeService.trigger(executionId)` |
| 场景     | 等外部系统通知（如支付回调）                             | 等人确认（如宿管点按钮）                          |

口诀：外部系统主动通知你 → Message Intermediate Catch；人完成任务后确认 → Receive Task。但两者都可以做对方的事，选哪个看团队习惯。

XML 形态：

```xml
<intermediateCatchEvent id="waitForDorm">
  <messageEventDefinition messageRef="dormConfirmed" />
</intermediateCatchEvent>
```

***

## 18. Message Intermediate Throw Event 消息中间抛出事件 —— 主动寄信

是什么：流程走到这里主动发一封信（消息），发完立刻继续，不等回信。像把信投进邮筒——投进去就走了，不站在邮筒旁等回信。

什么时候用：流程需要通知外部系统，但不需要等待响应的场景。比如"告诉考勤系统学生已请假"、"发送邮件通知家长"。

DEMO：班主任审批通过后，流程主动发一条消息给"全校通知系统"，告诉它"张三的请假已批准"。

```
[班主任审批] → (✉️→ 通知全校系统) → ◉
                    ↑
         Message Intermediate Throw
```

教程：

1. 拖一个空白中间事件到流程中间
2. 点小扳手 → 选   Message intermediate throw event  （实心信封图标）
3. 属性面板出现   Message 组  ：
   - Message  ：选择或新建消息名（如 `leaveApprovedNotification`）
4. 配置完成后，流程走到这里会自动触发消息。但光有消息定义不够——你需要在引擎里注册一个消息监听器个个来处理这条消息：
   ```java
   @EventListener
   public void onMessage(ExecutionEvent event) {
     if ("leaveApprovedNotification".equals(event.getMessageName())) {
       // 调用考勤系统 API、发邮件等
     }
   }
   ```
   或者更常见的做法：不用 Message Throw Event，直接用 Service Task 发 HTTP 请求（推荐，更可控）。DEMO 如下：
   ```xml
   <!-- 班主任审批通过后，直接用 Service Task 调通知系统 API -->
   <serviceTask id="notifySystem" name="发送请假通知"
       flowable:class="com.example.task.NotifySystemTask" />
   ```
   ```java
   public class NotifySystemTask implements JavaDelegate {

       @Override
       public void execute(DelegateExecution execution) {
           String applicant = (String) execution.getVariable("applicant");
           Integer days = (Integer) execution.getVariable("days");

           // 发 HTTP 请求到通知系统
           HttpClient.newHttpClient()
               .send(HttpRequest.newBuilder()
                   .uri(URI.create("https://notify.example.com/api/leave"))
                   .header("Content-Type", "application/json")
                   .POST(HttpRequest.BodyPublishers.ofString(
                       String.format("{\"applicant\":\"%s\",\"days\":%d}", applicant, days)
                   ))
                   .build(), HttpResponse.BodyHandlers.ofString());
       }
   }
   ```

深入：Message Throw 的实际用法

在 实际场景中，Message Throw Event 很少单独用——因为"发通知"通常是一个需要调外部 API 的动作，更适合用 Service Task（第 1 节）实现。

Message Throw Event 的真正价值在在在事件驱动架构在在中：A 流程抛出一个消息，B 流程（用 Message Start Event 或 Message Intermediate Catch）监听这个消息，实现流程间的解耦通信。

```
流程 A：[审批通过] → (抛: leaveApproved) → ◉
                              ↓
流程 B：○ → [更新考勤] ...   （用 Message Start Event 监听 leaveApproved）
```

XML 形态：

```xml
<intermediateThrowEvent id="notifySystem">
  <messageEventDefinition messageRef="leaveApprovedNotification" />
</intermediateThrowEvent>
```

***

## 19. Signal Intermediate Catch Event 信号中间捕获事件 —— 等全校广播

是什么：流程走到这里停下来等一个广播信号，信号到了才继续。像教室里等广播体操音乐——音乐响之前自由活动，音乐一响立刻集合。

什么时候用：需要等待某个全局事件发生的场景，且不在乎是谁发的。比如"等学校发布放假通知"、"等系统维护完成"。

和 Message Catch 的核心区别：

- Message   = 点名道姓的信（"给张三的快递"），一对一
- Signal   = 全校广播（"现在做广播体操"），一对多，谁听到谁响应

DEMO：学校发布了"台风放假"信号，所有正在运行的"请假审批流程"监听到后自动跳过班主任审批，直接批准。

```
[填请假单] → (📻 等"台风放假"信号) → [自动批准] → ◉
                ↑
      Signal Intermediate Catch
```

教程：

1. 拖一个空白白白中间事件白白到流程中间
2. 点小扳手 → 选   Signal intermediate catch event
3. 属性面板出现   Signal 组  ：
   - Signal  ：选择或新建信号名（如 `typhoonHoliday`）
4. 外部系统广播信号：
   ```java
   // 广播信号——所有监听 typhoonHoliday 的流程实例都会收到
   runtimeService.signalEventReceived("typhoonHoliday");
   ```
   注意：不需要 `executionId`！信号是广播，引擎会自动找到所有在 Signal Catch 节点等待的实例并唤醒它们。

深入：Signal 的两种玩法

| 用法   | 代码                                                       | 效果                            |
| ---- | -------------------------------------------------------- | ----------------------------- |
| 全局广播 | `runtimeService.signalEventReceived("信号名")`              | 所有  监听该信号的流程实例全部唤醒            |
| 指定实例 | `runtimeService.signalEventReceived("信号名", executionId)` | 只唤醒指定实例（极少用，失去了 Signal 的广播意义） |

场景典型用途：

- 系统维护通知  ：系统要停机维护，广播 `systemMaintenance` 信号，所有运行中的流程暂停到维护结束
- 政策变更  ：学校改了请假规则，广播 `policyChanged` 信号，正在跑的旧规则流程自动走新分支
- 节假日自动处理  ：广播 `holidayMode` 信号，所有审批流程自动走简化通道

XML 形态：

```xml
<intermediateCatchEvent id="waitForHolidaySignal">
  <signalEventDefinition signalRef="typhoonHoliday" />
</intermediateCatchEvent>
```

***

## 20. Signal Intermediate Throw Event 信号中间抛出事件 —— 主动发广播

是什么：流程走到这里主动发一个广播信号，发完立刻继续。像校长在在在广播室按下话筒在在喊"全校注意"，喊完该干嘛干嘛。

什么时候用：流程执行到某个节点时，需要通知所有相关方某个事件发生了。比如"审批完成了，所有人都知道了"。

DEMO：年级主任批准了 5 天以上的请假，流程发一个 `longLeaveApproved` 信号，考勤系统、宿舍系统、家长通知系统同时收到并各自处理。

```
[年级主任审批] → (📢 广播: longLeaveApproved) → ◉
                      ↑
           Signal Intermediate Throw
```

教程：

1. 拖一个空白中间事件到流程中间
2. 点小扳手 → 选   Signal intermediate throw event  （实心三角图标）
3. 属性面板出现   Signal 组  ：
   - Signal  ：选择或新建信号名（如 `longLeaveApproved`）
4. 流程走到这里自动广播信号，不需要额外代码

深入：Signal Throw 的实际价值和局限

Signal Throw 的价值在于一对多解耦：一个流程抛信号，多个流程/系统监听响应，彼此不知道对方存在。

但在场景中的局限：Signal Throw 只是"发个通知"，不保证对方收到、不处理失败重试。如果"发通知"是关键业务动作（如"必须通知到家长"），更推荐用   Service Task  （第 1 节）+ 异步 + 重试策略，确保可靠投递。

建议：Signal Throw 适合旁路通知（发了最好，没发到也不影响主流程）；关键通知用 Service Task。

XML 形态：

```xml
<intermediateThrowEvent id="broadcastApproval">
  <signalEventDefinition signalRef="longLeaveApproved" />
</intermediateThrowEvent>
```

***

## 21. Escalation Intermediate Throw Event 升级中间抛出事件 —— 向上告状

是什么：流程走到这里主动触发一个升级事件，通常是为了把问题向上汇报。像学生觉得班主任处理不公，写了一份申诉书递到年级主任那里。

什么时候用：当前处理人/节点无法解决问题，需要升级到更高层级处理的场景。比如"班主任 24 小时没审批，升级到年级主任"、"普通客服无法解决，升级到高级客服"。

DEMO：班主任看到请假理由是"去参加国际竞赛"，超出了自己的审批权限，触发 Escalation 升级到校长审批。

```
[班主任审批] → (⬆️ 升级: 超出权限) → [校长审批] → ◉
                    ↑
     Escalation Intermediate Throw
```

教程：

1. 拖一个空白中间事件到流程中间
2. 点小扳手 → 选   Escalation intermediate throw event  （实心向上箭头图标）
3. 属性面板出现   Escalation 组  ：
   - Escalation  ：选择或新建升级定义（如 `beyondAuthority`）
   - Escalation code  ：升级代码（如 `E001`），用于匹配对应的 Escalation 边界事件
4. 流程走到这里会抛出升级事件，需要配合 Escalation Boundary Event（第 24.5 节）才能接住--Escalation 不支持中间捕获事件，只能用边界事件或事件子流程的 Escalation Start Event 接收

深入：Escalation 和 Error 的区别

| <br /> | Escalation       | Error             |
| ------ | ---------------- | ----------------- |
| 语义     | "这件事我搞不定，找人帮忙"   | "出错了，流程没法继续"      |
| 后果     | 触发升级处理流程，原流程可以继续 | 通常触发错误处理，原流程终止或回滚 |
| 比喻     | 向老师请教难题          | 考试作弊被抓            |
| 场景     | 权限不足升级、超时升级      | 数据校验失败、系统异常       |

场景的实话：Escalation Throw 用得不多。常见的"超时升级"场景（如班主任 24 小时未审批就转给年级主任）通常用 Timer Boundary Event（第 24.1 节）直接实现，不需要 Escalation。Escalation 事件更适合"当前节点主动声明自己权限不足，请更高层级介人"这种场景。

XML 形态：

```xml
<intermediateThrowEvent id="escalateToPrincipal">
  <escalationEventDefinition escalationRef="beyondAuthority" />
</intermediateThrowEvent>
```

***

## 22. Conditional Intermediate Catch Event 条件中间捕获事件 —— 等条件变真

是什么：流程走到这里停下来等一个条件表达式变成 true，条件满足才继续。像在玩\*\*"木头人"游戏\*\*——你背对大家喊"一二三木头人"，转身后看到谁动了就抓谁；条件就是"有人动了"。

什么时候用：需要等待某个业务条件自动满足的场景。比如"等库存大于 100 才继续下单"、"等所有前置审批都完成了才进入最终审批"。

DEMO：学生提交请假单后，流程停在"等家长的电子签名完成"这一步，家长在手机 APP 上签完字后，条件 `${parentSigned == true}` 变成真，流程自动继续。

```
[填请假单] → (📋 等 parentSigned == true) → [班主任审批] → ◉
                ↑
   Conditional Intermediate Catch
```

教程：

1. 拖一个空白中间事件到流程中间
2. 点小扳手 → 选   Conditional intermediate catch event
3. 属性面板出现"条件表达式"组：
   - Condition  ：填条件表达式，如 `${parentSigned == true}`
4. 流程走到这里后，引擎会监听流程变量变化——当任何节点修改了 `parentSigned` 变量，引擎自动重新评估条件，一旦为真就唤醒流程

深入：Conditional Catch 的两种触发方式

| 方式     | 机制                               | 适用场景                |
| ------ | -------------------------------- | ------------------- |
| 变量变更触发 | 流程变量被 `setVariable` 修改时，引擎自动检查条件 | 内部状态变化（如用户点了确认按钮）   |
| 定时轮询   | 引擎定期重算条件表达式                      | 外部数据变化（如库存数量来自外部系统） |

Flowable 7 默认是变量变更触发。如果需要定时轮询外部数据，建议改用   Timer Intermediate Catch  + Service Task 查外部数据。

场景建议：Conditional Catch 很适合"等人完成某个动作"的场景——比如等家长签字、等室友确认、等所有会签完成。但注意：条件表达式只能访问流程变量树，不能查外部数据库（除非先把外部数据写进变量树）。

XML 形态：

```xml
<intermediateCatchEvent id="waitForSignature">
  <conditionalEventDefinition>
    <condition xsi:type="bpmn:tFormalExpression">${parentSigned == true}</condition>
  </conditionalEventDefinition>
</intermediateCatchEvent>
```

***

## 23. Link Intermediate Catch/Throw Event 链接事件 —— 流程图内的"跨页跳转"

是什么：一对配套的圆圈，Throw（抛出）跳到 Catch（捕获），像看书时的\*\*"见第 35 页"\*\*——流程从 Throw 瞬间跳转到 Catch，中间不走任何箭头。专门用来解决"流程图太大、线条到处交叉"的问题。

什么时候用：流程图很复杂、连线交叉像蜘蛛网时，用 Link 事件把两条远隔千里的线"隔空连接"。

DEMO：请假流程有 20 个节点，从第 3 步到第 18 步有一条长连线横跨整个画布。改成 Link 事件后，第 3 步抛出一个 `jumpToApproval` 链接，第 18 步捕获同一个链接，画布上只剩两个孤零零的圆圈，中间没有连线。

```
[第3步] → (🔗→ jumpToApproval)

...（中间省略 14 个节点，画布整洁）...

(🔗 jumpToApproval) → [第18步]
```

教程：

1. 在出发位置拖一个空白中间事件，点小扳手 → 选   Link intermediate throw event
2. 在目标位置拖一个空白中间事件，点小扳手 → 选   Link intermediate catch event
3. 两个节点的属性面板都出现   Link 组  ：
   - Link name  ：填同一个名字（如 `jumpToApproval`）————名字必须完全一致——才能配对
4. 流程走到 Throw 后，瞬间"瞬移"到 Catch，然后继续执行

深入：Link 事件的 3 条铁律

1. 必须成对出现  ：一个 Throw 必须有一个同名的 Catch 配对，否则部署报错
2. 只能在本流程图内跳转  ：不能跨流程、不能跳到子流程
3. 不改变流程语义  ：它只是"让图面好看"，引擎执行时完全等价于直接画一条长箭头

DSH 场景的实话：Link 事件几乎用不上。我们的流程通常不超过 10 个节点，连线不会交叉到需要 Link 的地步。把它留在设计器里是为了兼容复杂流程图，日常设计直接画箭头即可。

XML 形态：

```xml
<!-- 抛出端 -->
<intermediateThrowEvent id="linkThrow">
  <linkEventDefinition name="jumpToApproval" />
</intermediateThrowEvent>

<!-- 捕获端 -->
<intermediateCatchEvent id="linkCatch">
  <linkEventDefinition name="jumpToApproval" />
</intermediateCatchEvent>
```

***

## 24. Compensation Intermediate Throw Event 补偿中间抛出事件 —— 撤销刚才的操作

是什么：流程走到这里触发补偿机制，把之前已经执行过的操作撤销掉。像网购时点了"取消订单"，系统不仅要停止发货，还要把扣掉的钱退回来。

什么时候用：事务性流程中，后面的步骤发现前面的步骤需要回滚。比如"请假审批通过后，学生突然说不请了"——需要撤销已记录的请假、恢复考勤状态、通知班主任取消。

DEMO：请假流程走到"已批准"后，学生在代办中心点击"撤销申请"，流程触发补偿，把之前所有已执行的操作一一撤销。

```
[已批准] → (↩️ 触发补偿) → ◉
              ↑
   Compensation Intermediate Throw
```

教程：

1. 拖一个空白中间事件到需要触发补偿的位置
2. 点小扳手 → 选   Compensation intermediate throw event  （实心回退箭头图标）
3. 属性面板只有 General + Documentation，不需要额外配置
4. 关键  ：被补偿的任务必须事先配置补偿处理器——在每个可补偿任务上添加 Compensation Boundary Event，并连到补偿执行的 Service Task

```
[扣减库存] → (结束)
   ↓
  (↩️ Compensation Boundary) → [恢复库存]
```

深入：Compensation 的复杂性

Compensation 是 BPMN 中最复杂的机制之一：

- 需要为每个可补偿任务配置 Compensation Boundary
- 补偿执行顺序是反向的（最后执行的操作最先补偿）
- 补偿本身也可能失败，需要二次补偿

场景的实话：Compensation 极少直接使用。撤销申请的场景更简单：用 Terminate End Event结束流程，然后在后端写代码手动回滚数据。Compensation 事件更多用于严格的 Saga 分布式事务场景（如微服务间的跨服务回滚），我们的单体流程引擎很少需要它。

XML 形态：

```xml
<intermediateThrowEvent id="triggerCompensation">
  <compensateEventDefinition />
</intermediateThrowEvent>
```

***

## 25. Boundary Event 边界事件 —— 贴在任务身上的闹钟

是什么：贴在任务方框边缘的圆圈，表示"这个任务在执行过程中，如果被某件外部事情打断，就按这个边界事件指定的路走"。像贴在作业本上的便利贴闹钟——写着"如果 30 分钟还没写完，就跳过这题先做下一题"。

什么时候用：任务执行期间需要响应外部事件的场景。最典型的是超时处理——任务超过一定时间没人处理，自动走另一条路。

核心机制：中断 vs 非中断

边界事件分两种，小扳手切换时可以看到图标差异：

| 类型                       | 图标   | 效果                  |
| ------------------------ | ---- | ------------------- |
| 中断型  （Interrupting）      | 双线圆圈 | 任务被取消，流程走边界事件的出线    |
| 非中断型  （Non-interrupting） | 虚线圆圈 | 任务继续执行，同时额外触发一条并行路径 |

DEMO（中断型）：班主任审批任务限时 24 小时，超时自动转给年级主任。

```
         ┌─(⏰ 24h 超时)──→ [年级主任审批]
         │      ↑
[班主任审批]    Boundary Event (Timer, 中断型)
         │
         └─(正常批准)────→ ◉
```

DEMO（非中断型）：班主任审批任务每 2 小时催办一次，但审批任务本身不取消。

```
         ┌─(⏰ 每2h催办)──→ [发送催办通知]
         │      ↑
[班主任审批]    Boundary Event (Timer, 非中断型)
         │
         └─(正常批准)────→ ◉
```

教程：

1. 先拖一个任务（如 UserTask）到画布
2. 从调色板拖一个边界事件（圆圈内加闪电的图标）到任务的边缘，它会自动"吸附"在任务边框上
3. 点小扳手选择具体类型和是否中断：
   - Timer  ：等时间到
   - Message  ：等特定消息
   - Signal  ：等广播信号
   - Error  ：任务执行出错时触发
   - Escalation  ：任务触发升级时
   - Conditional  ：条件满足时触发
   - Compensation  ：触发补偿
4. 从边界事件拖一条出线到目标节点，这就是"打断后走哪条路"
5. 属性面板配置具体参数（如 Timer 组填时间）

> 只能贴在任务边缘，不能贴到网关上！   如果试图把边界事件拖到网关上，它会弹开。

***

### 25.1 Timer 边界事件 —— 任务超时处理

是什么：给任务设一个倒计时，时间到了触发处理。最常用的边界事件类型。

中断型：时间到了，任务作废，流程走另一条路。如"24 小时没审批，转给年级主任"。

非中断型：时间到了，任务继续，同时额外做一件事。如"每 2 小时催办一次"。

属性配置：和 Timer Intermediate Catch（第 16 节）完全一样——Date / Duration / Cycle 三种。

和 DSH 人工任务超时升级的关系：

| <br /> | Timer Boundary Event   | DSH 超时升级配置                     |
| ------ | ---------------------- | ------------------------------ |
| 位置     | 贴在 BPMN 任务上            | 写在任务属性的 assignment rule 里      |
| 效果     | 走另一条 BPMN 路径（如转给其他审批人） | 换 DSH agent 的预设会话（如从班主任换到年级主任） |
| 用哪个    | 流程改道走边界事件              | 换人批  用 DSH 超时升级                |

口诀：流程改道走边界事件，换人批用 DSH 超时升级。

***

### 25.2 Message 边界事件 —— 任务执行中被消息打断

是什么：任务执行过程中，如果收到特定消息，触发边界事件。像上课时被班主任叫出去谈话——课暂停，谈完回来继续（非中断）或者课不上了（中断）。

DEMO（中断型）：班主任正在审批，突然收到"学生已撤销申请"的消息，审批任务立刻取消。

```
         ┌─(✉️ 撤销申请)──→ ◉
         │      ↑
[班主任审批]    Boundary Event (Message, 中断型)
         │
         └─(正常批准)────→ ◉
```

唤醒方式：`runtimeService.messageEventReceived("消息名", executionId)`——和 Message Intermediate Catch 一样，但边界事件的 executionId 是任务对应的执行 ID。

***

### 25.3 Signal 边界事件 —— 任务执行中被广播打断

是什么：任务执行过程中，如果收到广播信号，触发边界事件。像全校广播"紧急疏散"——不管你在上什么课，都要响应。

DEMO（中断型）：学校广播"台风放假"信号，所有正在执行的审批任务立刻取消，直接进入"自动批准"节点。

```
         ┌─(📻 台风放假)──→ [自动批准] → ◉
         │      ↑
[班主任审批]    Boundary Event (Signal, 中断型)
         │
         └─(正常批准)────→ ◉
```

唤醒方式：`runtimeService.signalEventReceived("信号名")`——全局广播，所有监听该信号的边界事件同时触发。

***

### 25.4 Error 边界事件 —— 任务出错时兜底

是什么：任务执行过程中抛出错误时触发。像代码里的 `try-catch`——出错了不走正常路径，走错误处理路径。

DEMO：Service Task 调用外部 API 失败（如网络超时），Error 边界事件捕获错误，流程进入"人工处理异常"节点。

```
         ┌─(⚡ 调用失败)──→ [人工处理异常]
         │      ↑
[调外部API]     Boundary Event (Error)
         │
         └─(调用成功)────→ [继续流程]
```

配置：Error 边界事件需要指定   Error Code  （如 `API_TIMEOUT`），和任务抛出的错误代码匹配。任务里抛错误：

```java
throw new BpmnError("API_TIMEOUT", "调用外部 API 超时");
```

注意：Error 边界事件只有中断型（没有非中断型），因为出错了不可能继续执行原任务。

***

### 25.5 Escalation 边界事件 —— 任务触发升级时响应

是什么：任务执行过程中触发 Escalation（如权限不足）时响应。和第 21 节的 Escalation Throw 配合使用。

DEMO：Service Task 发现请假天数超过自己的审批权限，抛出 Escalation，边界事件捕获后转给更高权限的审批人。

```
         ┌─(⬆️ 权限不足)──→ [校长审批]
         │      ↑
[年级主任审批]  Boundary Event (Escalation)
         │
         └─(正常批准)────→ ◉
```

***

### 25.6 Conditional 边界事件 —— 条件满足时触发

是什么：任务执行过程中，某个条件表达式变成 true 时触发。和 Conditional Intermediate Catch类似，但贴在任务上。

DEMO：班主任审批任务执行期间，如果学生点击"撤销申请"（变量 `cancelled` 变成 true），边界事件触发，任务取消。

```
         ┌─(📋 cancelled)──→ ◉
         │      ↑
[班主任审批]    Boundary Event (Conditional)
         │
         └─(正常批准)────→ ◉
```

***

### 25.7 Compensation 边界事件 —— 任务的补偿处理器

是什么：贴在任务上的补偿执行器。当 Compensation Throw Event 触发时，所有带有 Compensation 边界事件的任务会按相反顺序执行补偿。

配置：Compensation 边界事件不需要连线——它只定义"这个任务被补偿时执行什么操作"，通常连到一个 Service Task 做撤销操作。

```
[扣减库存]
   ↓
  (↩️ Compensation Boundary) → [恢复库存]
```

注意：Compensation 边界事件没有中断/非中断之分，它只在 Compensation Throw 触发时执行。

***

### 边界事件速查表

| 边界事件类型       | 触发时机                  | 有非中断型 | DSH 常用度   |
| ------------ | --------------------- | ----- | --------- |
| Timer        | 时间到了                  | 是     | ⭐⭐⭐⭐⭐ 最常用 |
| Message      | 收到特定消息                | 是     | ⭐⭐⭐       |
| Signal       | 收到广播信号                | 是     | ⭐⭐        |
| Error        | 任务抛错误                 | 否     | ⭐⭐⭐       |
| Escalation   | 任务触发升级                | 是     | ⭐         |
| Conditional  | 条件表达式为真               | 是     | ⭐⭐        |
| Compensation | Compensation Throw 触发 | N/A   | ⭐         |
| Cancel       | 事务子流程取消时              | 否     | 极少用       |

***

# 附录 A：条件表达式（UEL）速查

写在连线的"条件表达式"输入框里：

| 意思               | 写法                                         |
| ---------------- | ------------------------------------------ |
| 请假天数 ≥ 3         | `${days >= 3}`                             |
| 审批结果为通过          | `${approvalResult == 'approved'}`（字符串要加引号） |
| 金额大于 1000 且级别为 A | `${amount > 1000 && level == 'A'}`         |
| 结果为驳回            | `${approvalResult != 'approved'}`          |
| 判断变量是否存在         | `${days != null}`                          |

"多个条件任一满足"用 `||`（或），单独列出是因为 `|` 在 Markdown 表格里是列分隔符：

```text
${days >= 3 || level == 'A'}
```

> 所有条件里引用的变量（如 `days`），都必须由上游节点提前写入流程变量树--通过"输出 Process Variables 定义"校验写入，或在 Script Task 里 `execution.setVariable(...)` 写入。变量没写就引用，运行时报 `Unknown property used in expression`。

# 附录 B：时间格式（ISO-8601）速查

Timer 相关组件（Timer 中间事件 / 边界事件 / 事件网关的定时选手）都用这套格式：

| 想表达                | 填法                          |
| ------------------ | --------------------------- |
| 30 分钟              | `PT30M`                     |
| 24 小时              | `PT24H`                     |
| 3 天                | `P3D`                       |
| 1 小时 30 分钟         | `PT1H30M`                   |
| 某个具体时刻             | `2026-09-01T08:00:00`       |
| 某个具体时刻（明确北京时间）     | `2026-09-01T08:00:00+08:00` |
| 每 10 分钟一次，共 3 次    | `R3/PT10M`                  |
| 每 12 小时催一次，最多 10 次 | `R10/PT12H`                 |
| 每 1 小时一次，无限重复      | `R/PT1H`（R 后不写数字 = 一直重复）    |

记法：`P`=时间段（Period）开头，日期单位直接跟（D 天、M 月、Y 年），时间单位前面要加 `T`（T 之后才有 H 小时、M 分钟、S 秒）；`R`=重复（Repeat）次数。注意 `M` 在 `T` 前面是"月"（如 `P1M`=1 个月），在 `T` 后面是"分钟"（如 `PT1M`=1 分钟）。
