/**
 * Task submission mapping confirmation dialog.
 *
 * <p>The AI-generated JSON is read-only. The employee can add / edit / delete
 * source (JSON field path) → target (context variable path) mappings. Closing
 * the dialog discards edits; the caller decides whether to re-open with the
 * default mapping again. Mapping assembly itself lives in workbench/pure.ts
 * (shared with tests); this file owns only the editing UI.
 */
import { useCallback, useMemo, useState } from 'react'
import { Button, Input, JsonTree, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Task } from './task-api.ts'
import {
  buildVariables, defaultMappings, targetOptions,
} from './workbench/pure.ts'
import type { SubmitMapping } from './workbench/pure.ts'
import { JSON_TREE_LABELS } from './jsonTreeLabels.ts'
import css from './TaskSubmitDialog.module.css'

type TaskSubmitDialogProps = {
  open: boolean
  task: Task
  jsonText: string
  submitting?: boolean
  submitError?: string | null
  onClose: () => void
  onSubmit: (variables: Record<string, unknown>) => void
}

export function TaskSubmitDialog({
  open, task, jsonText, submitting = false, submitError = null, onClose, onSubmit,
}: TaskSubmitDialogProps) {
  const meta = task.dshMeta
  const contextVariables = meta?.contextVariables ?? []
  const initialMappings = useMemo<SubmitMapping[]>(
    () => defaultMappings(meta?.outputMappings),
    [meta],
  )

  const [mappings, setMappings] = useState<SubmitMapping[]>(initialMappings)
  const [error, setError] = useState<string | null>(null)

  const parsedJson = useMemo<unknown>(() => {
    try {
      return JSON.parse(jsonText)
    } catch {
      return undefined
    }
  }, [jsonText])

  const jsonTreeData = useMemo<object | unknown[] | null>(() => {
    if (parsedJson === null) return null
    if (typeof parsedJson !== 'object') return null
    return parsedJson as object | unknown[]
  }, [parsedJson])

  const addMapping = useCallback(() => {
    setMappings(prev => [...prev, { source: '', target: '' }])
  }, [])

  const removeMapping = useCallback((index: number) => {
    setMappings(prev => prev.filter((_, i) => i !== index))
  }, [])

  const updateMapping = useCallback((index: number, key: keyof SubmitMapping, value: string) => {
    setMappings((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [key]: value } as SubmitMapping
      return next
    })
  }, [])

  const targetOptionList = useMemo(() => targetOptions(contextVariables), [contextVariables])

  const handleSubmit = useCallback(() => {
    setError(null)
    if (parsedJson === undefined) {
      setError('JSON 格式不合法，无法提交')
      return
    }
    try {
      const variables = buildVariables(parsedJson, mappings, contextVariables)
      onSubmit(variables)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [parsedJson, mappings, contextVariables, onSubmit])

  return (
    <Modal open={open} onClose={onClose} title="提交待办" headless={true} className={css.modal ?? ''}>
      <div className={css.dialog}>
        <div className={css.header}>
          <h3 className={css.title}>提交待办：{task.name ?? task.id}</h3>
          <p className={css.subtitle}>将 AI 生成的 JSON 字段映射到流程上下文变量</p>
        </div>

        <div className={css.body}>
          <div className={css.jsonPanel}>
            <div className={css.panelLabel}>AI 输出 JSON（只读）</div>
            {jsonTreeData !== null ? (
              <JsonTree data={jsonTreeData} label="AI 输出 JSON" labels={JSON_TREE_LABELS} />
            ) : (
              <div className={css.jsonError}>不是合法 JSON 对象/数组</div>
            )}
          </div>

          <div className={css.mappingPanel}>
            <div className={css.panelLabel}>输出映射</div>
            <div className={css.mappingList}>
              {mappings.map((m, idx) => (
                <div key={idx} className={css.mappingRow}>
                  <Input
                    value={m.source}
                    onChange={(e) => { updateMapping(idx, 'source', e.target.value) }}
                    placeholder="JSON 字段路径"
                    className={css.sourceInput ?? ''}
                  />
                  <span className={css.arrow}>→</span>
                  <select
                    value={m.target}
                    onChange={(e) => { updateMapping(idx, 'target', e.target.value) }}
                    className={css.targetSelect}
                  >
                    <option value="">(选择变量)</option>
                    {targetOptionList.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    onClick={() => { removeMapping(idx) }}
                    className={css.removeButton}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" onClick={addMapping} className={css.addButton}>
              + 添加映射
            </Button>
          </div>
        </div>

        {error !== null && <div className={css.error}>{error}</div>}
        {submitError !== null && submitError !== '' && <div className={css.error}>{submitError}</div>}

        <div className={css.actions}>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? '提交中…' : '确认提交'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
