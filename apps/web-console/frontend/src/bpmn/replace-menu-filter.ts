/**
 * bpmn-js 设计器入口过滤器:隐藏指定组件的创建/替换入口。
 *
 * <p>diagram-js 的 PopupMenu 与 Palette 都按 priority 从高到低依次执行各
 * provider 的 get*Entries;返回函数时,函数收到此前累积的 entries 并可改写
 * 后返回(PopupMenu._getEntries / Palette.addPaletteEntries 的 updater 模式)。
 * 内置 provider 以 DEFAULT_PRIORITY(1000)注册,本过滤器以更低优先级
 * (900,更晚执行)删除累积结果中的隐藏条目,其余入口不受影响。
 *
 * <p>隐藏清单与理由(引擎仍支持,设计器只藏入口,需要时可手写 XML):
 * <ul>
 *   <li>替换菜单:Complex Gateway(复杂网关)——"凑够 N 个放行"应使用多实例
 *       任务的完成条件(教程第 12 节),复杂网关易配错且无标准替代不了的
 *       场景。</li>
 *   <li>替换菜单:Send Task(发送任务)——Flowable 引擎只支持
 *       flowable:type(mail/camel/dmn)或 Web Service operationRef,不支持
 *       delegateExpression/expression/class(引擎解析器静默忽略 + 发布校验器
 *       拒绝);官方手册的邮件/HTTP/Shell/Camel 示例也全部写在 serviceTask 上。
 *       发通知一律用 Service Task + 委托表达式(教程第 1.5 节)。</li>
 *   <li>替换菜单:Business Rule Task(业务规则任务)——Flowable 7 的
 *       BusinessRuleParseHandler 一律创建 Drools 行为(BusinessRuleTaskActivity
 *       Behavior,需 kie-api 依赖),工厂方法只认 class,flowable:expression/
 *       delegateExpression 被完全忽略,缺 kie-api 时部署直接
 *       NoClassDefFoundError。调 DMN 决策表一律用 Service Task + 表达式
 *       dmnRuleService(教程第 6.1 节)。</li>
 *   <li>替换菜单头部(任务节点):标准循环 Loop 图标——不是多实例(同一份任务
 *       反复执行直到条件不满足),与候选人派发/计票/集合派发机制无关;人工节点与
 *       ServiceTask(含 DSH backend task)都用并行/串行多实例,循环图标已隐藏
 *       (教程第 11 节组合速查)。</li>
 *   <li>调色板:Data Store Reference(数据存储引用)——DSH 场景的数据载体是
 *       流程变量树(context),节点输出经"输出 Process Variables 定义"校验后
 *       写入变量树,下游直接读;Data Store 只作图面标注、不参与引擎数据流,
 *       留在调色板里徒增困惑(教程第 15 节)。</li>
 * </ul>
 */
import type PopupMenuProvider from 'diagram-js/lib/features/popup-menu/PopupMenuProvider'
import type { PopupMenuEntries } from 'diagram-js/lib/features/popup-menu/PopupMenuProvider'
import type { PopupMenuTarget } from 'diagram-js/lib/features/popup-menu/PopupMenu'
import type PopupMenu from 'diagram-js/lib/features/popup-menu/PopupMenu'
import type PaletteProvider from 'diagram-js/lib/features/palette/PaletteProvider'
import type { PaletteEntries } from 'diagram-js/lib/features/palette/PaletteProvider'
import type Palette from 'diagram-js/lib/features/palette/Palette'
import { isAny } from 'bpmn-js/lib/util/ModelUtil'

/**
 * 替换菜单头部条目的运行时形态:diagram-js 类型声明为 list,实际累积为
 * keyed record(bpmn-js ReplaceMenuProvider._getLoopCharacteristicsHeaderEntries
 * 按 'toggle-parallel-mi' 等 key 合并,PopupMenu._getHeaderEntries 的 updater
 * 分支把 record 传给本过滤器)。
 */
type HeaderEntries = Record<string, unknown>

/** 要隐藏的替换菜单条目 actionName(定义于 bpmn-js ReplaceOptions.js 的 GATEWAY 数组)。 */
const HIDDEN_REPLACE_ACTIONS = new Set(['replace-with-complex-gateway', 'replace-with-send-task', 'replace-with-rule-task'])

/** 要隐藏的调色板条目 id(定义于 bpmn-js PaletteProvider.js 的 getEntries)。 */
const HIDDEN_PALETTE_ENTRIES = new Set(['create.data-store'])

function ReplaceMenuFilterProvider(this: PopupMenuProvider, popupMenu: PopupMenu) {
  popupMenu.registerProvider('bpmn-replace', 900, this)
}

ReplaceMenuFilterProvider.prototype.getPopupMenuEntries = function () {
  return function (entries: PopupMenuEntries) {
    for (const action of HIDDEN_REPLACE_ACTIONS) {
      delete entries[action]
    }
    return entries
  }
}

ReplaceMenuFilterProvider.prototype.getPopupMenuHeaderEntries = function (target: PopupMenuTarget) {
  return function (entries: HeaderEntries) {
    // 人工节点与 ServiceTask 均隐藏标准循环(Loop)图标:重做语义与候选人派发/
    // 计票/集合派发无关,DSH 任务节点只用并行/串行多实例。多选时 target 是
    // 数组,不过滤。断言理由:PopupMenuTarget 声明为 diagram-js Element,
    // 替换菜单的运行时 target 实为 bpmn-js shape(带 businessObject),
    // is() 需要 bpmn-js Element。
    if (!Array.isArray(target)
      && isAny(target as Parameters<typeof isAny>[0], ['bpmn:UserTask', 'bpmn:ServiceTask'])) {
      delete entries['toggle-loop']
    }
    return entries
  }
}

ReplaceMenuFilterProvider.$inject = ['popupMenu']

function PaletteFilterProvider(this: PaletteProvider, palette: Palette) {
  palette.registerProvider(900, this)
}

PaletteFilterProvider.prototype.getPaletteEntries = function () {
  return function (entries: PaletteEntries) {
    for (const id of HIDDEN_PALETTE_ENTRIES) {
      delete entries[id]
    }
    return entries
  }
}

PaletteFilterProvider.$inject = ['palette']

export const ReplaceMenuFilterModule = {
  __init__: ['replaceMenuFilterProvider', 'paletteFilterProvider'],
  replaceMenuFilterProvider: ['type', ReplaceMenuFilterProvider],
  paletteFilterProvider: ['type', PaletteFilterProvider],
}
