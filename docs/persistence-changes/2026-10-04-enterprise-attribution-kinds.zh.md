---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-enterprise-attribution-kinds

[English](2026-10-04-enterprise-attribution-kinds.md) | 中文

## 概述

新增经资格认定的 user-identity-context 与 kb-context 消息来源，承载企业身份展示块与知识库检索展示块。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-enterprise-attribution-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "b0b9a515eedc96315ecd48a5019fe1bcf610d9937a969d0f42588b85c4a75ed5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "9d8c51ad73d913cc34ddb06309fce32021222196effb02face27c4323df163ec"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "b491393d5675b3e261706e0f27257a53c208c3f229b66bc205c1165a2e6285c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "84a5432c9d430ac8ee9727798648a951f955a238521b2dc3a73e3390d7bb392d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有日志不含此类来源，仍然有效。两种来源均为普通 user/developer 消息上的资格认定归属（attribution）：企业包注入的 ContextFormed 展示区块，仅被企业客户端用于展示分组，并由包不变量校验。未部署企业包的读者保留消息本体、按内容推导历史。事件类型、Session 头与格式版本均不变。

<a id="verification"></a>
## 验证

tsx scripts/persistence-changes.ts --check 通过：八处来源新增全部归类为仅归属（attribution-only），requiresVersionBump 为 false。tsx scripts/gen-persistence-catalog.ts --check 报告 docs/persistence-catalog.md、docs/persistence-catalog.zh.md、docs/persistence-catalog.i18n.yaml、packages/core/session/src/known-event-types.ts、docs/persistence-schema.json 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
