/**
 * DSH BPMN moddle 扩展描述符。
 *
 * XML 契约必须与 Flowable 引擎侧 DshBpmnExtensionParser 严格对齐:
 * namespace 为 http://dsh.ai/bpmn,元素 local name 为 assignmentRule /
 * userPrompt / skillRef / actionPolicy / timeoutPolicy / sodRule /
 * contextVariables / contextVariable / field / outputMappings / mapping /
 * backendTask,引擎解析按 local name 取值。
 *
 * Process Context 机制(design 2026-09-01):
 * - process 级 <dsh:contextVariables>:流程上下文变量声明(八种类型,
 *   object 挂字段清单,array 声明 itemType);
 * - userTask 级 <dsh:outputMappings>:员工提交 JSON → 上下文变量的映射;
 * - 代码节点(delegate/脚本/DMN)读写变量都在代码内直接 getVariable/setVariable,
 *   无需也不再有节点级标注元素。
 *
 * tagAlias: 'lowerCase' 使类型名 AssignmentRule 序列化为 <dsh:assignmentRule>;
 * 同理 ContextVariable → <dsh:contextVariable>。
 */

/** dsh: 命名空间 URI(对齐引擎 DshBpmnExtensionParser.DSH_NAMESPACE)。 */
export const DSH_NAMESPACE = 'http://dsh.ai/bpmn'

export const dshModdleDescriptor = {
  name: 'Dsh',
  uri: DSH_NAMESPACE,
  prefix: 'dsh',
  xml: {
    tagAlias: 'lowerCase',
  },
  types: [
    {
      // 人工节点责任规则:<dsh:assignmentRule candidateRoleId="..."/>
      // (单人/会签/串签语义由 BPMN 原生 multiInstanceLoopCharacteristics 表达,
      // 不再单独配置处理策略)
      //
      // 组织维度审批路由扩展(design 2026-09-19 §4,属性互斥与引擎
      // DshExtensionProperties.AssignmentRule 对齐):
      // - 实体角色:candidateRoleId;orgScope 缺省=全公司(存量行为),
      //   sameLine=同行政线 / fixedUnit=指定部门(须同时给 fixedUnitId);
      // - 虚拟角色:virtualRole = parent / grandparent / child / grandchild
      //   (隐含同行政线,不写 orgScope/fixedUnitId)。
      name: 'AssignmentRule',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'candidateRoleId', isAttr: true, type: 'String' },
        { name: 'orgScope', isAttr: true, type: 'String' },
        { name: 'virtualRole', isAttr: true, type: 'String' },
        { name: 'fixedUnitId', isAttr: true, type: 'String' },
      ],
    },
    // userPrompt 存 text 属性:<dsh:userPrompt text="..."/>。
    // 不用元素正文:引擎 StAX 配置 IS_REPLACING_ENTITY_REFERENCES=false 会把含引号的
    // 正文切成多个 CHARACTER 事件,Flowable 的 setElementText 只保留最后一段,
    // JSON 骨架会被截断;属性值由 getAttributeValue 一次性完整解码,
    // 与 flowable:class 等 Flowable 扩展属性同一存储模式(引擎 DshBpmnExtensionParser 对齐)。
    // allowedIn 兼 UserTask 与 ServiceTask:DSH backend task(serviceTask 上的
    // dsh:backendTask)复用同一 prompt 语义(design 2026-09-14 §3.1)。
    {
      name: 'UserPrompt',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask', 'bpmn:ServiceTask'] },
      properties: [{ name: 'text', isAttr: true, type: 'String' }],
    },
    {
      // 多值 skill 引用:<dsh:skillRef>name</dsh:skillRef>(每个 skill 一个元素);
      // user task 与 DSH backend task 共用
      name: 'SkillRef',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask', 'bpmn:ServiceTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      // 动作策略容器:<dsh:actionPolicy><dsh:timeoutPolicy .../><dsh:sodRule .../></dsh:actionPolicy>
      name: 'ActionPolicy',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'timeoutPolicy', type: 'dsh:TimeoutPolicy' },
        { name: 'sodRule', isMany: true, type: 'dsh:SodRule' },
      ],
    },
    {
      // 超时升级目标优先级(引擎 DshTaskEscalationDelegate 对齐):
      // escalateToVirtualRole(parent/grandparent,锚定当前审批人)
      // > escalateToUserId > escalateToRoleId
      name: 'TimeoutPolicy',
      superClass: ['Element'],
      properties: [
        { name: 'duration', isAttr: true, type: 'String' },
        { name: 'escalateToRoleId', isAttr: true, type: 'String' },
        { name: 'escalateToUserId', isAttr: true, type: 'String' },
        { name: 'escalateToVirtualRole', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'SodRule',
      superClass: ['Element'],
      properties: [{ name: 'type', isAttr: true, type: 'String' }],
    },
    // ----- Process Context 机制(design 2026-09-01) -----
    {
      // 流程级上下文变量声明容器:
      // <dsh:contextVariables><dsh:contextVariable .../>...</dsh:contextVariables>
      name: 'ContextVariables',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:Process'] },
      properties: [
        { name: 'contextVariable', isMany: true, type: 'dsh:ContextVariable' },
      ],
    },
    {
      // 单个上下文变量:name 流程内唯一;type 八种(string/integer/float/boolean/
      // date/datetime/object/array);source="start-param" 标记启动传入,
      // source="system" 标记系统注入(当前唯一注入器 initiator,启动时按登录人
      // 写入 userId/name/email);initialValue 初始值(与 start-param 可共存兜底);
      // itemType 为 array 的元素类型;object/array 元素为 object 时挂 field 字段清单。
      name: 'ContextVariable',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' },
        { name: 'initialValue', isAttr: true, type: 'String' },
        { name: 'itemType', isAttr: true, type: 'String' },
        { name: 'source', isAttr: true, type: 'String' },
        { name: 'field', isMany: true, type: 'dsh:Field' },
      ],
    },
    {
      // object 字段清单条目(支持嵌套:field 类型为 object 时可再挂 field)
      name: 'Field',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' },
        { name: 'field', isMany: true, type: 'dsh:Field' },
      ],
    },
    {
      // userTask 输出映射容器:source=提交 JSON 的顶层字段/点路径(空=整体),
      // target=上下文变量名(可带 .field 深入路径);引擎提交端点执行写入。
      // allowedIn 兼 UserTask 与 ServiceTask:DSH backend task 的输出映射
      // 由引擎 delegate 直接执行写入(design 2026-09-14 §3.1)
      name: 'OutputMappings',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask', 'bpmn:ServiceTask'] },
      properties: [
        { name: 'mapping', isMany: true, type: 'dsh:Mapping' },
      ],
    },
    {
      name: 'Mapping',
      superClass: ['Element'],
      properties: [
        { name: 'source', isAttr: true, type: 'String' },
        { name: 'target', isAttr: true, type: 'String' },
      ],
    },
    {
      // 会签计票规则(design 2026-09-15;三种 task 统一):
      // <dsh:votingRule variable="approved" passValue="true" passCount="3" rejectCount="2"/>
      // userTask / DSH backend task:variable 必须是本节点输出映射 target 根变量
      // (提交端点 / delegate 输出映射写入的表决字段);普通 ServiceTask:variable
      // 为已声明的上下文变量(delegate 代码 setVariable 写入)。
      // 引擎按值聚合 dsh_passCount_<taskId>/dsh_rejectCount_<taskId>(userTask 在
      // 提交端点,serviceTask 在多实例 end listener),parse 时自动生成完成条件
      // (配了 votingRule 的节点不再手写 completionCondition)
      name: 'VotingRule',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask', 'bpmn:ServiceTask'] },
      properties: [
        { name: 'variable', isAttr: true, type: 'String' },
        { name: 'passValue', isAttr: true, type: 'String' },
        { name: 'passCount', isAttr: true, type: 'String' },
        { name: 'rejectCount', isAttr: true, type: 'String' },
      ],
    },
    // ----- DSH backend task(design 2026-09-14 §3.1;多实例扩展 2026-09-15) -----
    {
      // DSH 后端任务标记:<dsh:backendTask backendProfileUrl="..."/>。
      // 存在于 bpmn:ServiceTask 的 extensionElements 即识别为 DSH backend task
      // (delegate 固定绑定 ${dshBackendTaskDelegate} + async,由 palette 创建时写入);
      // backendProfileUrl 为单实例调用的 backend profile 实例 URL,发布校验查注册表存在性;
      // 多实例时改用 backendProfile 子元素列表(第 i 个实例绑第 i 个 URL,
      // 长度须等于 loopCardinality,引擎 delegate 按 loopCounter 取)
      name: 'BackendTask',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:ServiceTask'] },
      properties: [
        { name: 'backendProfileUrl', isAttr: true, type: 'String' },
        { name: 'backendProfile', isMany: true, type: 'dsh:BackendProfile' },
      ],
    },
    {
      // 多实例时每实例绑定的 backend profile:<dsh:backendProfile url="..."/>,
      // 顺序对应实例序号(loopCounter)
      name: 'BackendProfile',
      superClass: ['Element'],
      properties: [{ name: 'url', isAttr: true, type: 'String' }],
    },
  ],
}

/**
 * Flowable 命名空间最小描述符:覆盖 Web Console 需要编辑的属性。
 *
 * - ServiceTask/SendTask/BusinessRuleTask:flowable:class / expression / delegateExpression
 * - ServiceTask/SendTask/BusinessRuleTask:failedJobRetryTimeCycle
 *   (失败重试周期,extensionElements 子元素;引擎仅对 async 任务的异步 Job 生效)
 * - MultiInstanceLoopCharacteristics:collection / elementVariable
 *   (普通 ServiceTask 多实例的集合形式,与引擎 inputDataItem/elementVariable 对齐;
 *   userTask 不配——collection 由引擎按候选角色补齐)
 * - Task/CallActivity:async(异步执行,async-executor 线程池)
 * - CallActivity:inheritVariables(子流程继承流程变量树)
 * - UserTask:candidateUsers / candidateGroups(人工节点兜底)
 *
 * SendTask 的画布入口已隐藏(replace-menu-filter),描述符仍保留 SendTask:
 * 粘贴含 flowable: 属性的 sendTask XML 时往返保真,非法组合由引擎发布校验报错。
 *
 * 官方 bpmn-js-properties-panel 的 CamundaPlatform provider 绑定 camunda: 命名空间,
 * 对 Flowable 引擎无效,因此 Flowable 属性组由 DshPropertiesProvider 自行提供。
 */
export const flowableModdleDescriptor = {
  name: 'Flowable',
  uri: 'http://flowable.org/bpmn',
  prefix: 'flowable',
  xml: {
    tagAlias: 'lowerCase',
  },
  types: [
    {
      name: 'AsyncBehaviour',
      extends: ['bpmn:Task', 'bpmn:CallActivity'],
      properties: [{ name: 'async', isAttr: true, type: 'Boolean' }],
    },
    {
      // 自动类任务的三种实现方式,Flowable 引擎按属性名路由到对应执行器
      name: 'ImplementationBehaviour',
      extends: ['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'],
      properties: [
        { name: 'class', isAttr: true, type: 'String' },
        { name: 'expression', isAttr: true, type: 'String' },
        { name: 'delegateExpression', isAttr: true, type: 'String' },
      ],
    },
    {
      // 失败重试周期:<flowable:failedJobRetryTimeCycle>R5/PT1M</flowable:failedJobRetryTimeCycle>
      // (extensionElements 子元素;配合 async 使用,同步任务抛异常时事务直接回滚无重试)
      name: 'FailedJobRetryTimeCycle',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      // 多实例集合形式(普通 ServiceTask):flowable:collection=数组变量名(纯名,
      // 引擎 parse 时编译为 JUEL 表达式运行时求值),flowable:elementVariable=引擎
      // 逐实例注入的元素变量名(Java delegate getVariable 读取,与教程约定一致)。
      // 与引擎 MultiInstanceLoopCharacteristics 的 inputDataItem/elementVariable 对齐。
      name: 'MultiInstanceCollectionBehaviour',
      extends: ['bpmn:MultiInstanceLoopCharacteristics'],
      properties: [
        { name: 'collection', isAttr: true, type: 'String' },
        { name: 'elementVariable', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'CallActivityBehaviour',
      extends: ['bpmn:CallActivity'],
      properties: [
        { name: 'inheritVariables', isAttr: true, type: 'Boolean' },
      ],
    },
    {
      name: 'CandidateBehaviour',
      extends: ['bpmn:UserTask'],
      properties: [
        { name: 'candidateUsers', isAttr: true, type: 'String' },
        { name: 'candidateGroups', isAttr: true, type: 'String' },
      ],
    },
    // 注意:SequenceFlow 的条件表达式不在此声明——引擎只识别 BPMN 原生
    // <conditionExpression xsi:type="bpmn:tFormalExpression"> 子元素,
    // bpmn-moddle 原生已声明该属性,由 DshPropertiesProvider 直接读写。
  ],
}
