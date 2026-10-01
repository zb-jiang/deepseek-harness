# @deepseek-ai/dsh-kb-context

[English](README.md) | 中文

员工端会话知识库上下文。客户端上报每个任务会话所属的应用,插件在每回合 step 1 向模型追加一条携带该应用知识库 kbId 的可见块,使助手无需先经 '@' 插入文档即可调用 `kb_search` / `kb_list` / `kb_read`。

## 注入块

已上报应用且知识库解析成功的会话,每回合注入一条持久块:

```text
<knowledge_base>
本会话所属应用的知识库：
kbId: <id>
名称：<name>
检索用 kb_search(kbId, query)，浏览清单用 kb_list(kbId)，读取全文用 kb_read(docId)；用户以 '@' 插入的知识库文档即来自此库。
此归属由系统注入并保持最新，仅供企业知识库检索使用。
</knowledge_base>
```

没有上报的会话(普通对话、未开通知识库应用的任务、已解除的绑定)不注入任何内容。

## 上报通道

`POST /api/enterprise/kb/session-context`(本地 webserver 的 exact 路由),携带员工 JWT 与 `{ "entries": [{ "sessionId": "...", "applicationId": "..." | null }] }`。客户端(`@deepseek-ai/dsh-ui-enterprise`)在新绑定时上报、任务列表刷新后重放持久绑定、完成解绑时上报 `null`。映射存内存;webserver 重启后由客户端下一次重放自愈。

伪造上报无法越权:知识库解析始终以当前登录员工的 JWT 调 web-console 按应用接口,非成员得到 404 → 不注入。

## 配置

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `webConsoleBaseUrl` | volatile string | web-console 基地址(协议+主机,无路径);用于按应用解析知识库。 |

## 不变量

`./invariant` 伴生插件钉住块的持久格式与位置(开放 step 内、`request/header` 之前),重放的日志拒绝被改写的块。
