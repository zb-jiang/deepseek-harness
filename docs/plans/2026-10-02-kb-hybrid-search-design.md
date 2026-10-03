# 知识库混合检索设计:三路召回 + RRF 融合 + rerank 精排

日期:2026-10-02,2026-10-03 增补 rerank 精排。状态:已实现(web-console 后端 + `@deepseek-ai/dsh-knowledge` 插件)。

本文记录员工端知识库检索的最终设计:三条召回路径、统一的文档级候选、RRF 融合、rerank 精排、snippet 摘录规则与对外契约。数据库扩展与建表见 [2026-09-21-local-pg-setup-guide.md](./2026-09-21-local-pg-setup-guide.md)。

## 1. 为什么需要三条检索路径

只用关键词匹配的问题是:用户问「差旅开销怎么报」,而文档里写的全是「费用报销」,字面对不上就搜不到。向量语义检索能对上意思,但对精确的编号、金额、专有名词不敏感。所以三条路径同时跑,互补短板:

| 路径   | 数据基础                                                       | 擅长               |
| ---- | ---------------------------------------------------------- | ---------------- |
| 向量路 | `kb_chunks.embedding`(halfvec(2560),Qwen3-Embedding-4B) | 换一种说法也能命中(语义) |
| 关键词路 | `kb_documents` 的 name 与 text\_content(pg\_trgm 扩展)         | 精确字面:编号、名称、错别字容忍 |
| 全文路  | `kb_documents.fts` 生成列(pg\_jieba 分词)                       | 按词命中,标题权重高于正文    |

三条路径只收录 `parse_status='ready'` 的文档;正在解析或解析失败的文档不出现在任何结果里。

## 2. 三条路径各自怎么取候选

调用方传 `topK`(默认 8),每条路径取 `3 × topK` 个候选(topK=8 时每路 24 个),给后面的融合留出余量。

- **向量路**:把查询文本也调 embedding 模型转成向量,在 `kb_chunks` 里按余弦距离取最近的若干块,并**过滤掉距离超过阈值(默认 0.7,env `KB_EMBEDDING_MAX_DISTANCE`)的块**——kNN 的"最近 N 个"对任意查询都必然有输出,无阈值时垃圾查询也产生候选。阈值只负责挡掉极端垃圾,边界候选的相关性裁决交给 §5 的 rerank 精排。返回的是「块级」原始行(某文档的第几块、块文本)。2560 维在 HNSW 索引上限内(halfvec 4000 维),余弦排序走 HNSW 近似索引,毫秒级返回。
- **关键词路**:用 pg\_trgm 的相似度对文档名和正文做 ILIKE 匹配,按相似度排序。返回「文档级」行(每篇文档一条)。
- **全文路**:查询文本经 jieba 分词转成 tsquery,命中 `fts` 生成列,按 ts\_rank 排序。返回「文档级」行。

若调用方传了 `folderId`,三条路径统一只搜该文件夹及其子文件夹(含自身)。

向量路阈值取值依赖 embedding 模型:Qwen3-Embedding-4B 实测相关查询最近块距离 ≤0.53、无关但正常的查询 ≥0.57,两者挤在连续分布里,单案例标定的紧阈值(如 0.55)在不同查询上表现不稳定,可能误杀边界候选。所以阈值放宽到 0.7,只裁掉明显无关的尾部,「相关/无关」的最终裁决交给 §5 的 rerank 精排;换 embedding 模型需重新标定。

## 3. 统一成文档级候选:向量路的块聚合

三条路径原本粒度不一(向量路是块,词法两路是文档),融合前先把向量路聚合成文档级,规则:

1. 向量路的原始行按 docId 分组,每篇文档得到一个候选;
2. 文档的分数 = 该文档每个块的 RRF 名次分之和:`Σ 1/(60 + 块的名次)`(名次从 1 起);
3. 文档的摘录(snippet)= 名次最优那个块的文本。

效果:一篇 50 页的文档如果有多处段落相关,分数累加后会排得更靠前,但**只占结果列表一个位置**,由摘录代表它出场。这样三条路径的候选字段完全一致:`(docId, docName, folderId, snippet)`。

## 4. RRF 融合:名次换分数,同文档累加

RRF(Reciprocal Rank Fusion)把每条路径里的名次换算成分数:`1/(60 + 名次)`,名次从 1 起;同一文档在多条路径出现时分数相加,按总分从高到低取前 **2×topK** 进入 §5 的 rerank 精排候选池(rerank 关闭或失败降级时按 RRF 序直接取前 topK)。**取并集,不是取交集**:只被一条路径命中的文档照常参与排序,被多条路径命中的文档分数累加、自然排到前面。

融合示例(topK=8,每路 24 候选,此处只列前列):

| 文档      | 向量路       | 关键词路  | 全文路   | 总分                           | 排名 |
| ------- | --------- | ----- | ----- | ---------------------------- | -- |
| 《报销标准》  | 第 2、5 名两块 | 第 1 名 | 第 2 名 | 1/62+1/65+1/61+1/62 ≈ 0.0645 | 1  |
| 《差旅制度》  | 未命中       | 第 3 名 | 第 1 名 | 1/63+1/61 ≈ 0.0323           | 2  |
| 《出差审批单》 | 第 1 名一块   | 未命中   | 未命中   | 1/61 ≈ 0.0164                | 3  |

常数 k=60 的作用:把名次差距抹平(第 1 名 0.0164 与第 10 名 0.0143 只差一点点),单路的领先优势变小,跨路累加才有决定权。总分决定候选池的进出与排序,rerank 启用时的最终排序与 `score` 由重排分接管(见 §5);不同知识库、不同查询之间的分数不可比较。总分相同时,按候选首次出现的顺序稳定排序。

## 5. rerank 精排:重排分决定最终 topK

RRF 融合有两个局限:一是只用名次、丢掉原始分值,第 1 名和第 2 名差距多大都看不出来;二是双塔 embedding 的距离分只是相关性的粗略近似——相关与无关的分数挤在连续分布里(实测相关 ≤0.53、无关 ≥0.57),单靠一个距离阈值切分,阈值在不同查询上表现不稳定。行业通用做法是两段式:**召回宽松(宁可多留),精排用 rerank 模型做最终裁决**。

rerank 模型(默认 Qwen/Qwen3-Reranker-8B,env `KB_RERANK_MODEL`)是 cross-encoder:把 query 和文档拼在一起逐对送进模型打分,两侧词元在编码时充分交互,分数比双塔距离准得多。实测其分数呈明显双峰分布:无关文档贴地(0.0001~0.0024),相关文档 0.26 以上,断档在 0.02~0.26 之间——跨查询的分数稳定性远好于 embedding 距离,阈值可移植。

管线(在 RRF 融合之后):

1. RRF 按总分降序取前 2×topK 进入精排候选池,给 rerank 留淘汰余量;
2. 每篇候选的送评文本 = 文档名 + 换行 + 最终 snippet(与 §6 规则 4 同源,rerank 看到的和用户看到的摘录一致);
3. 调 rerank API(`POST {rerankApiUrl}/rerank`,cohere 风格;基址与 Key 通过 `KB_RERANK_API_URL`/`KB_RERANK_API_KEY` 独立配置——rerank 与 embedding 不一定同供应商,默认同为硅基流动),请求 `{model, query, documents}`,响应 `results` 数组按分数降序、`index` 指向 documents 下标;
4. 过滤重排分低于阈值的候选(默认 0.1,env `KB_RERANK_MIN_SCORE`,取值 [0,1) 左闭右开)——0.1 落在断档区间 0.02~0.26 中间,宁可多留不错杀(取 0.5 会把 0.26~0.47 的弱相关块整段砍掉);
5. 按重排分降序取前 topK,`score` 字段替换为重排分(0~1,越大越相关)。

**降级语义(fail open)**:rerank 常开、无独立开关;仅当调用失败(超时/HTTP 错误/响应不合法)时不阻塞检索主路径——按 RRF 总分序直接取前 topK,`score` 语义回退为 RRF 融合分,同时记 warn 日志;trace 的 `rerankPool` 中该批 `rerankScore` 为 null,前端据此显示降级提示。降级期间检索质量退回纯 RRF 水平,功能不中断。

## 6. snippet 摘录规则

snippet 是每条命中附带的原文摘录,**是原文截取,不是 LLM 生成的摘要**(不烧 token、不会改写原意、检索路径零额外延迟)。按层定规则:

1. 向量路 chunk 候选:snippet = chunk 原文;
2. 向量路文档级候选(同文档块聚合后):snippet = 该文档名次最优块的文本;
3. 关键词路 / 全文路候选:snippet = 文档 text\_content 前 1000 字符(SQL 层 `substring` 截取);
4. 最终结果(`kb_search` 输出):snippet = 文档前 1000 字符 + 名次最优块(该文档有向量命中时,换行拼接;纯词法命中只有文档前 1000 字符)。

第 4 层由 `KnowledgeService#finalSnippets` 统一组合:文档摘录按候选池(2×topK)批量一次查询,名次最优块从向量路候选(名次升序)取每篇文档首块;一方缺失取另一方,两方皆缺回退融合前的默认 snippet。组合结果同时用作 §5 rerank 的送评文本与最终输出,保证 rerank 看到的和用户看到的摘录一致。

## 7. 对外契约

后端两个入口,行为一致:

- 员工端:`GET /api/kb/{kbId}/search?query=...&folderId=...&topK=...`(JWT,做成员校验);
- 服务密钥端:`GET /api/backend/kb/{kbId}/search?...`(X-Service-Key,backend profile 无人值守用)。

调试端(见 §9):`GET /api/kb/{kbId}/search-debug?query=...&folderId=...&topK=...`(JWT,成员校验),执行与检索完全相同的流程并额外返回中间态。

响应为文档级命中列表,每条字段:`docId`、`docName`、`folderId`(null 为根)、`snippet`(规则见 §6)、`score`(正常为 rerank 重排分 0~1;本次 rerank 调用失败降级时为 RRF 融合分)。`topK` 缺省 8,超出 1\~50 自动收敛。`folderId` 传的是文件夹 id;员工端 AI 工具侧传的是路径,由工具先解析成 id。

检索相关配置(env,均有代码内默认):召回阈值 `KB_EMBEDDING_MAX_DISTANCE`(默认 0.7,只挡极端垃圾)、`KB_RERANK_MODEL`(默认 Qwen/Qwen3-Reranker-8B)、`KB_RERANK_MIN_SCORE`(默认 0.1,[0,1) 左闭右开)。外部 API 两组配置相互独立:embedding 用 `KB_EMBEDDING_API_URL` + `KB_EMBEDDING_API_KEY`,rerank 用 `KB_RERANK_API_URL` + `KB_RERANK_API_KEY`(两者不一定同供应商,默认同为硅基流动);两组 Key 缺失任一即启动失败——rerank 常开,无独立开关。

代码位置:

| 屏            | 文件                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| SQL 三路查询     | web-console `KnowledgeJdbcRepository`(searchVectorCandidates / searchKeywordCandidates / searchFtsCandidates) |
| 块聚合 + RRF 融合 | web-console `KnowledgeService#rrfMerge`(纯函数)                                                                  |
| rerank 客户端   | web-console `KbRerankClient`(与 `KbEmbeddingClient` 同基址同 Key)                                                   |
| rerank 管线    | web-console `KnowledgeService#rerankPipeline` + `applyRerank`(纯函数)                                               |
| 端点           | `KnowledgeController#search`、`BackendKbController#search`                                                     |
| 检索 debug 端点  | `KnowledgeController#searchDebug`                                                                             |
| trace 组装     | web-console `KnowledgeService#buildTrace`(纯函数)                                                                |
| AI 工具        | `@deepseek-ai/dsh-knowledge` 的 `kb_search` / `kb_read` / `kb_list`                                            |

## 8. 与 kb\_search 工具的衔接

`kb_search` 是员工端 AI 会话里模型可调用的工具:入参 `kbId + query`(可选 `folderPath`、`topK`),内部调上面的检索端点,把文件夹路径解析成 id、把结果里的 folderId 回填成路径,渲染为逐行文本(名称、docId、路径、相关度、摘要)。模型读到 snippet 后自行判断:够回答就直接作答,不够就再调 `kb_read(docId)` 读全文。两者之间没有强制编排,靠工具描述衔接。

## 9. 检索 debug 可视化(web console「知识库」菜单)

web console 左侧「知识库」菜单(全员可见;检索内容访问沿用成员校验)把一次查询的检索过程画出来,用于检索调试:选中知识库 → 输入查询文本 → 页面调用 debug 端点并渲染「查询向量化 → 三路候选泳道 → RRF 融合 → 融合结果泳道(2×topK 候选池)→ rerank 精排泳道 → 最终 topK」总览图,点击任意候选或结果行弹出该阶段的打分明细抽屉(每个阶段的抽屉只展示本阶段信息:候选行看原始分与命中块、融合行看跨路贡献构成、重排行看 RRF 分→重排分与阈值、结果行看最终分与摘录)。

debug 端点与检索走同一执行体(`runSearch`),保证视图与真实检索语义一致;响应额外携带 `paths`(三路候选逐行含路内名次、原始排序分、块下标与 RRF 贡献)、`rerankPool`(2×topK 精排候选池:每篇文档的 RRF 融合分、重排分与是否进入 topK)、`docs`(出现在任意一路的文档级明细,含全部贡献行、总分、最终名次与是否进入 topK)与 `results`(与检索响应完全一致)。原始分语义随路不同:向量路为余弦距离(越小越近),关键词路为 pg\_trgm 相似度,全文路为 ts\_rank;RRF 融合本身只用名次,原始分仅供调试展示。

前端泳道中 rerank 为紫色泳道(区别于三路语义色):逐行展示候选池的 RRF 分 → 重排分,低于 `rerankMinScore` 的行置灰标「低于阈值」,topK 分界线后的行标「备选」;本次 rerank 调用失败降级时(`rerankScore` 全为 null)泳道顶部显示降级提示,结果列按 RRF 分排序。

每次 debug 查询都会真实执行一次查询向量化与 rerank 调用,调用成本与普通检索一致。
