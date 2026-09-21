# 组织维度审批路由任务清单

> 2026-09-19 修订:单主部门模型改为 **org\_unit\_members 映射表 + 发起身份选择**(design §3/§5.1/决策 10)。阶段 1-3 按旧模型落地,由阶段 4/5 返工覆盖;阶段 6 起为原计划顺延。

## 阶段 1:治理数据(旧模型,已被阶段 4 返工覆盖)

- [x] 1.2 web-console 后端 `OrgUnitRepository`:树查询(一次拉全量内存组树)、CRUD、负责人更新;同级同名唯一与循环引用应用层校验
- [x] 1.3 web-console 后端 `OrgUnitService` + `OrgUnitController`:部门树读(嵌套树 JSON)、增删改、负责人指定;system\_admin 权限;写操作记 audit\_events
- [x] 1.4 web-console 后端 UserService:用户主部门分配/清空;Dto 加 orgUnitId/orgUnitName;列表批量补部门名(沿用 findDisplayNames 批量模式,避免 N+1)
- [x] 1.5 web-console 前端:部门管理页(树形展示 + 增删改 + 负责人选择)
- [x] 1.6 web-console 前端:用户管理页加主部门列/编辑

## 阶段 2:引擎候选解析(锚点来源由阶段 5 返工覆盖)

- [x] 2.1 引擎 `DshOrgUnitRepository`:按 id 查部门(含 head\_user\_id)、按子树收集部门集合、父/祖父查询、子部门扇出查询(查 public.org\_units,沿用 DshApplicationRepository 跨 schema 模式)
- [x] 2.2 引擎 `DshCandidateResolver`:实现组合矩阵六场景解析 + §5.3 边界规则(到顶自动通过/空候选报错)+ §5.4 跳过申请人本人;输入=dsh\_applicant\_org\_unit\_id + assignmentRule,输出=候选 user.id 列表或"到顶自动通过"信号
- [x] 2.3 引擎 `DshBpmnExtensionParser`:解析 orgScope/virtualRole/fixedUnitId 新属性(互斥规则校验)
- [x] 2.4 引擎 `DshMultiInstanceSetupListener`:候选来源切换为 DshCandidateResolver;到顶信号→跳过任务创建直接 complete(记审计变量);SoD 过滤在解析结果上执行(不改动现有 SoD 语义)
- [x] 2.5 引擎 `DshTaskEscalationDelegate`:escalateToRole 支持 virtualRole/orgScope(升级目标走同一解析器)
- [x] 2.6 引擎 H2 单测:六场景矩阵逐个断言;边界(到顶自动通过/父部门无负责人报错/空扇出报错/跳过申请人本人/存量无 orgScope=全公司回归)

## 阶段 3:web-console 启动链路与发布校验(锚点来源由阶段 4 返工覆盖)

- [x] 3.1 `ProcessInstanceService.start`:注入第四变量 `dsh_applicant_org_unit_id`;启动校验——流程含 sameLine 范围节点(虚拟角色或 sameLine 实体角色)而申请人无部门→报错"请先在管理后台分配部门";全 fixedUnit/global 节点不要求
- [x] 3.2 `BpmnContextParser`:解析新属性(供启动校验与属性回显)
- [x] 3.3 发布校验扩展:orgScope 枚举合法;virtualRole 枚举合法且不与 candidateRoleId 共存;fixedUnit 时 fixedUnitId 必填且部门存在;sameLine 实体角色存在性(现有校验复用)
- [x] 3.4 web-console 单测:启动校验分支、发布校验规则

## 阶段 4:多部门映射与发起身份(web-console,返工)

- [x] 4.1 Supabase 手工 DDL(setup guide §11 追加):`org_unit_members` 建表(org\_unit\_id + user\_id 联合唯一,RLS 同 org\_units);存量迁移(platform\_users.org\_unit\_id 非空行逐行插入映射,ON CONFLICT 跳过);迁移后 `ALTER TABLE platform_users DROP COLUMN org_unit_id`
- [x] 4.2 治理层多对多:OrgUnitMemberJdbcRepository(批量查/覆盖写/按部门移除);OrgUnitService 负责人指定自动 upsert 映射、移除成员时阻止 head;UserService `assignOrgUnits`(覆盖写)替换 assignOrgUnit,UserDto orgUnitId→orgUnits 列表,列表批量补部门名沿用
- [x] 4.3 位置与发起 API:`GET /api/runtime/my-org-positions`(当前登录人部门 id/名称/到根路径);StartProcessInstanceRequest 加 orgUnitId;start 启动校验改 0/唯一/多分支(多身份未传报错、传了校验归属防伪造);start 端点权限扩展到应用成员(app\_memberships 成员可发起)
- [x] 4.4 web-console 前端:Users 页所属部门多选编辑 + 部门标签列;发起对话框身份下拉(拉 my-org-positions)
- [x] 4.5 web-console 单测:位置 API、start 身份分支(0/1/N、防伪造、权限)、负责人自动入映射
- 验收:`mvn test`(web-console backend)通过;管理台可维护多部门、按身份发起

## 阶段 5:引擎返工(成员判定/派发局部变量/升级锚点)

- [x] 5.1 `DshOrgUnitRepository`:findRoleMembersByOrgUnitIds 改 join org\_unit\_members(部门成员判定走映射表);升级回退反查改查映射表(唯一部门/0 个/多个)
- [x] 5.2 派发写局部变量:DshMultiInstanceSetupListener 多实例逐人 assign 时把"解析出该 assignee 的部门"写任务局部变量 `dsh_assignment_org_unit`
- [x] 5.3 `DshTaskEscalationDelegate`:升级锚点优先读局部变量;缺失时回退映射表唯一部门,0 个/多个报错 fail loud
- [x] 5.4 H2 单测更新:成员判定走映射表、局部变量写入、升级锚点回退分支
- 验收:`mvn test`(flowable-engine)通过

## 阶段 6:设计器

- [x] 6.1 `dsh-moddle.ts`:dsh:assignmentRule 扩展 orgScope/virtualRole/fixedUnitId 属性描述;timeoutPolicy 加 escalateToVirtualRole(升级目标虚拟角色)
- [x] 6.2 userTask 属性面板:审批范围下拉(同行政线/指定部门/全公司,缺省全公司);目标角色实体/虚拟切换;虚拟角色选项(上一级/上两级/下一级/下两级,选中时范围置灰锁 sameLine);指定部门时部门树选择器;超时升级目标加虚拟角色选项(parent/grandparent,优先级最高)
- [x] 6.3 前端 typecheck 通过
- 验收:设计器可配置六场景矩阵全部组合并正确序列化 BPMN

## 阶段 7:DSH 员工端

- [x] 7.1 员工端(enterprise profile)上下文注入组织位置(本地 webserver 代理调 my-org-positions)
- [x] 7.2 AI 对话发起流程的身份选择交互:多位置先确认身份,选后以 orgUnitId 调 start API
- 验收:员工在 AI 对话中发起流程,多身份时被询问,单身份/无身份(流程不含 sameLine)免问

## 阶段 8:端到端验证(浏览器)

- [ ] 8.1 A/B 部门隔离:同行政线+实体角色,A 部门员工提交仅 A 部门该角色成员收到待办;B 部门经理不可见
- [ ] 8.2 上一级链:虚拟 parent——员工提交→部门负责人;部门负责人提交→上级负责人;总经理提交→到顶自动通过,审计留痕,流程继续走后续节点
- [ ] 8.3 发文会签:虚拟 child 扇出下级所有部门负责人,single/countersign/sequential 策略行为正确
- [ ] 8.4 指定部门:财务复核节点仅指定部门子树内该角色成员收到
- [ ] 8.5 多身份发起:员工兼 A/B 两部门,以 A 身份发起走 A 线审批;以 B 身份发起走 B 线;伪造 orgUnitId 被拒
- [ ] 8.6 跨部门成员判定:员工兼 A/B 两部门,sameLine 实体角色待办两条线都能派到
- [ ] 8.7 存量流程回归:无 orgScope 的已发布流程行为与升级前完全一致
- [ ] 8.8 超时升级:escalateToRole 配虚拟"上一级",超时后升级到父部门负责人;global 待办升级且审批人多部门时报错不静默
