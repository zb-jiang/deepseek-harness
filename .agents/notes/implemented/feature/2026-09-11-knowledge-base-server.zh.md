# Agent Note: 企业知识库服务端(web-console)

Status: implemented

[English](2026-09-11-knowledge-base-server.md) | 中文

## 问题

每个企业应用需要一个全员平等读写的共享知识库:文档按文件夹组织、图片 OCR 进检索索引,并为后续阶段(管理页签、员工端 DSH 插件)提供检索底座。产品决策归设计文档 `docs/plans/2026-09-11-knowledge-base-design.md` 所有;服务端部分——三张 `public` 表加 Supabase Storage——需要一套不破坏平台"无 service_role"凭据纪律的实现。

## 决策

`com.dsh.console.knowledge` 在 setup guide §12 表结构上实现设计 §5 的 REST 面(按应用开通知识库、文件夹树、文档上传/列表/下载/删除)。每个请求把知识库解析到 `application_id`,要求操作者是 active 成员(`app_memberships` active × `platform_users` active——与 RLS 谓词完全同口径,复用于 `KnowledgeJdbcRepository.isActiveMember`);`system_admin` 免成员校验。写操作走既有 postgres JDBC 连接(表 owner,不受 RLS 限制);文件字节走 Supabase Storage REST,透传调用方 JWT 并携带 anon key 作 `apikey` 头——全程不出现 service_role。应用首次开通知识库时,桶登记复用同一条 JDBC 路径(`INSERT INTO storage.buckets ... ON CONFLICT DO NOTHING`),无手工建桶步骤。

解析管线(`KbParsePipeline` + `DocumentParser`)直接消费 multipart 字节——绝不从 Storage 回读,这正是透传用户 JWT 在后台线程可行的前提。单线程 executor 串行 Tika/OCR(50MB 上限约束单文档内存),回写 `text_content`/`parse_status`,失败记 `failed` 并带原因。按扩展名分流:纯文本按 UTF-8 直读,图片走 tess4j(`chi_sim+eng`,未配 `TESSDATA_PATH` 则该文档解析失败),pdf/office 走 Tika,未知类型记 `ready` 无文本(仅名称可检索)。检索为名称 + `text_content` 的 `ILIKE`,只命中 `ready` 行;列表载荷携带摘要窗口(命中 ±80/160 字符,否则前 200 字符)而非全文。`KB_MAX_UPLOAD_MB` 同时驱动 Spring multipart 上限与 `KnowledgeProperties`。

## 备选方案

**Storage 用 service_role key。** 可免去用户 JWT 依赖,但违反平台凭据纪律(不持有共享提权密钥);透传方案还让 RLS 独立承担每次对象读取的成员校验。

**持久化解析队列。** 为了重启存活性要引入持久化队列,而对象至多数百份、失败形态(`pending` 停滞)可见且重新上传即恢复,阶段一不值得引入队列机制。

**tsvector 检索。** 中文分词依赖 zhparser/pgroonga,其在 Supabase 的可用性未验证;对同一 `text_content` 列做 `ILIKE` 保证二期向量路径(读取同列)不变。

## 后果

阶段二(管理页签)与阶段三(员工端插件:代理路由、`kb_search`/`kb_read`/`kb_list` 工具、会话选择器、工作空间上传)按原样调用这些端点;"非 `ready` 文档不进检索结果"的不变式须由每个消费方自行维持。`GET /api/apps/{appId}/kb` 在成员首次访问时开通,应用的知识库因此隐式存在。重启遗留物仅限 `pending` 行与失败事务留下的 Storage 对象,两者均无 GC——在设计量级下可接受。
