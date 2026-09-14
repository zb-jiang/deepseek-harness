/**
 * 知识库文档 chip 行:conversation.input.dock 座位占据者(design 2026-09-11 §6)。
 *
 * <p>展示当前会话输入框里的 kbDocs reference chip(文档名 + 移除入口),
 * 数据源是座位注入的 InputState.occurrences(source=kbDocs 的投影,随
 * 编辑器编辑实时更新;'@' 菜单选中的与选择器确认的同源同列)。移除经
 * KnowledgeWorkbench.removeSelection 删除编辑器里的 chip,草稿文本同步
 * 收缩,已发送消息不撤回。空列表不渲染(input.dock 的加法语义)。
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { KB_SOURCE_NAME } from './knowledge-workbench.ts'
import type { KnowledgeWorkbench } from './knowledge-workbench.ts'
import css from './KbChipsDock.module.css'

/** input.dock 座位注入面:知识库工作台(chip 移除动作)。 */
export type KbChipsDockInjected = {
  knowledge: KnowledgeWorkbench
}

/** input.dock 座位组件 props:InputZone(input 投影)+ session 标准 kit + 注入面。 */
export type KbChipsDockProps =
  & PropsRuntime<'conversation.input.dock'>
  & KbChipsDockInjected

/** 知识库文档 chip 行(见模块文档)。 */
export function KbChipsDock({ sessionId, input, knowledge }: KbChipsDockProps): ReactNode {
  const chips = input.occurrences.filter(occurrence => occurrence.source === KB_SOURCE_NAME)
  if (chips.length === 0) return null
  return (
    <div className={css.dock} data-kb-chips="">
      {chips.map(occurrence => (
        <span key={occurrence.occurrenceId} className={css.chip} title={occurrence.label}>
          <span className={css.chipName}>{occurrence.label}</span>
          <button
            type="button"
            className={css.chipRemove}
            aria-label={`移除 ${occurrence.label}`}
            onClick={() => { knowledge.removeSelection(sessionId, occurrence.ref) }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
