/**
 * 知识库选择器入口:conversation.input.left 座位占据者(design 2026-09-11 §6)。
 *
 * <p>仅待办绑定的会话且其应用已开通知识库时渲染「知识库」入口按钮:
 * 当前会话经 EnterpriseWorkbench 的任务绑定解析待办,再凭
 * Task.applicationId 经 KnowledgeWorkbench 的缓存解析知识库;解析失败/
 * 未开通(null)都不渲染(设计:无知识库的应用选择器入口隐藏)。点击
 * 打开选择器 Modal,确认后由 Modal 把引导文本写入会话草稿;chip 行
 * (input.dock)单独展示已选文档。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconContextInjectionOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import type { KnowledgeWorkbench } from './knowledge-workbench.ts'
import type { KnowledgeBase } from './kb-api.ts'
import { KbPickerModal } from './KbPickerModal.tsx'
import { useSnapshot } from './workbench/hooks.ts'
import css from './KbPickerButton.module.css'

/** input.left 座位注入面:两个工作台编排器。 */
export type KbPickerInjected = {
  workbench: EnterpriseWorkbench
  knowledge: KnowledgeWorkbench
}

/** input.left 座位组件 props:session 标准 kit + 注入面。 */
export type KbPickerButtonProps =
  & PropsRuntime<'conversation.input.left'>
  & KbPickerInjected

/**
 * 知识库选择器入口按钮(见模块文档):三态 —— 解析中/未开通不渲染,
 * 已开通渲染图标按钮 + Modal。
 */
export function KbPickerButton({ sessionId, workbench, knowledge }: KbPickerButtonProps): ReactNode {
  const bindings = useSnapshot(workbench.bindings)
  const tasks = useSnapshot(workbench.tasks)
  const [open, setOpen] = useState(false)
  // undefined = 解析中;null = 未开通;对象 = 已开通。
  const [kb, setKb] = useState<KnowledgeBase | null | undefined>(undefined)

  const taskId = bindings.sessionToTask[sessionId]
  const task = taskId !== undefined ? tasks.items.find(item => item.id === taskId) : undefined
  const appId = task?.applicationId ?? null

  useEffect(() => {
    if (appId === null) {
      setKb(undefined)
      return undefined
    }
    let alive = true
    setKb(undefined)
    knowledge.kbForApp(appId).then(
      (resolved) => { if (alive) setKb(resolved) },
      () => { if (alive) setKb(null) },
    )
    return () => { alive = false }
  }, [appId, knowledge])

  if (appId === null || kb === null || kb === undefined) return null

  return (
    <>
      <button
        type="button"
        className={css.button}
        aria-label="选择知识库文档"
        title="选择知识库文档"
        onClick={() => { setOpen(true) }}
      >
        <IconContextInjectionOutlineMedium size={15} />
        <span className={css.label}>知识库</span>
      </button>
      <KbPickerModal
        open={open}
        kb={kb}
        sessionId={sessionId}
        knowledge={knowledge}
        onClose={() => { setOpen(false) }}
      />
    </>
  )
}
