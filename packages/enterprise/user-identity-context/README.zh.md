# @deepseek-ai/dsh-user-identity-context

[English](README.md) | 中文

企业侧会话身份上下文。`ctx.currentUser` 保存最近一次验签通过的平台用户；agent loop 每轮的第一个 step 向模型请求注入一段身份块，让助手在整个对话中知道"当前登录人是谁"。

## Model Experience

每轮 turn 的 step 1 追加一条 plugin 来源（`form: 'snapshot'`）的 user message：

```
<user_identity>
当前登录人：张三（zhangsan@corp.com）
userId: 9f3e8…
认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：
eyJhbGciOi…
此身份由系统注入并保持最新，仅供称呼与表单填写展示。认证令牌仅在调用企业系统时作为 Authorization: Bearer 请求头使用，不要在回复中展示、转述或写入文件。
</user_identity>
```

- 身份字段（姓名/邮箱/userId/组织身份）只是**展示**；认证令牌供助手以当前员工身份调用企业内部系统（Supabase SSO 签发、bearer 认证，通用对接机制），不得在回复中展示、转述或写入文件。
- 存储为空（尚未登录/已登出）时不注入任何内容；已登录但尚未拿到令牌时令牌段省略。
- `./invariant` 伴随插件校验注入块的确切格式与来源归属（与 time-context 同机制），由测试与诊断装配显式挂载。

## 数据流

| 触点 | 行为 |
| ---- | ---- |
| `GET /api/enterprise/auth/me`（platform-user-api） | 验签成功后发出 `platform-user/verified` 事件 |
| `POST /api/enterprise/auth/signout`（platform-user-api） | 发出 `platform-user/signout` 事件 |
| `platform-user/verified` 事件（本插件订阅） | `ctx.currentUser.observe(user)` |
| `platform-user/signout` 事件（本插件订阅） | `ctx.currentUser.clear()` |
| 员工端 `switchAccount`（ui-enterprise） | 登出时调用 signout 端点 |

事件在 `@deepseek-ai/dsh-platform-user` 包声明；`platform-user-api` 发射、本插件消费，两个包互不依赖。内存态，进程重启后由客户端下一次 `/me` 重建。

## Known Limitations and Deferred Work

- 会话中途 token 过期时，最后一次验签身份会保留到下一个触点；该窗口内助手以旧令牌调用企业系统会得到 401，下一轮身份块携带新令牌后自愈。
- 员工端浏览器刷新令牌后，下一次 `/me` 验签把新令牌喂给 `ctx.currentUser`，身份块随之更新。
- 层 2（调用层凭据传递给工具与 MCP）由身份块的认证令牌段承担通用传递；专用工具（如 process-start）仍走服务端附令牌路径。
