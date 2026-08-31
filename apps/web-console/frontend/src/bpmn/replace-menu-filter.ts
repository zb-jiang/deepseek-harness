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
 *       任务的完成条件(教程第 12.1 节),复杂网关易配错且无标准替代不了的
 *       场景。</li>
 *   <li>调色板:Data Store Reference(数据存储引用)——DSH 场景的数据载体是
 *       流程变量树(context),节点输出经"输出 Process Variables 定义"校验后
 *       写入变量树,下游直接读;Data Store 只作图面标注、不参与引擎数据流,
 *       留在调色板里徒增困惑(教程第 15 节)。</li>
 * </ul>
 */
import type PopupMenuProvider from 'diagram-js/lib/features/popup-menu/PopupMenuProvider'
import type { PopupMenuEntries } from 'diagram-js/lib/features/popup-menu/PopupMenuProvider'
import type PopupMenu from 'diagram-js/lib/features/popup-menu/PopupMenu'
import type PaletteProvider from 'diagram-js/lib/features/palette/PaletteProvider'
import type { PaletteEntries } from 'diagram-js/lib/features/palette/PaletteProvider'
import type Palette from 'diagram-js/lib/features/palette/Palette'

/** 要隐藏的替换菜单条目 actionName(定义于 bpmn-js ReplaceOptions.js 的 GATEWAY 数组)。 */
const HIDDEN_REPLACE_ACTIONS = new Set(['replace-with-complex-gateway'])

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
