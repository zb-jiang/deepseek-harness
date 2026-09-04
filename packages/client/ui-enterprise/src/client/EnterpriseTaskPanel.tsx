/**
 * Enterprise task-completion workbench for the DSH enterprise profile.
 *
 * <p>Lists the current user's Flowable user tasks, shows the selected task's
 * userPrompt / skillRefs, accepts the AI-generated JSON, and opens the
 * mapping confirmation dialog before submitting variables to the engine.
 *
 * <p>This is a deliberately minimal first version: the AI conversation itself
 * still runs in DSH's main chat surface. The employee copies the task prompt
 * into a chat, pastes the resulting JSON here, and completes the task.
 * Future iterations can create a DSH session from the prompt directly.
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Task } from './task-api.ts'
import { completeTask, getMyTasks, readTokenSubject } from './task-api.ts'
import { useAuth } from './EnterpriseUi.tsx'
import { TaskSubmitDialog } from './TaskSubmitDialog.tsx'
import css from './EnterpriseTaskPanel.module.css'

export function EnterpriseTaskPanel() {
  const { currentUser } = useAuth()
  const tokenSubject = readTokenSubject()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showDialog, setShowDialog] = useState(false)

  const selectedTask = tasks.find(t => t.id === selectedId) ?? null

  const loadTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await getMyTasks()
      setTasks(list)
      setSelectedId(current => (current == null && list.length > 0 ? list[0]?.id ?? null : current))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  const handleCopyPrompt = useCallback(async () => {
    if (selectedTask?.dshMeta?.userPrompt == null) return
    await writeClipboard(selectedTask.dshMeta.userPrompt)
  }, [selectedTask])

  const handleSubmit = useCallback(async (variables: Record<string, unknown>) => {
    if (selectedTask == null) return
    setSubmitting(true)
    setError(null)
    try {
      await completeTask(selectedTask.id, variables)
      setShowDialog(false)
      setJsonText('')
      await loadTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [selectedTask, loadTasks])

  return (
    <div className={css.panel}>
      <div className={css.sidebar}>
        <div className={css.sidebarHeader}>
          <h3 className={css.sidebarTitle}>我的待办</h3>
          <Button variant="outline" onClick={() => { void loadTasks() }} disabled={loading}>
            刷新
          </Button>
        </div>
        {loading && <div className={css.hint}>加载中…</div>}
        {!loading && tasks.length === 0 && error == null && (
          <div className={css.hint}>
            暂无待办
            <br />
            当前用户: {currentUser?.displayName ?? '-'} ({tokenSubject ?? '未登录'})
          </div>
        )}
        {error !== null && (
          <div className={css.error}>
            {error}
            <br />
            <span className={css.hint}>
              当前用户: {currentUser?.displayName ?? '-'} ({tokenSubject ?? '未登录'})
            </span>
          </div>
        )}
        <div className={css.taskList}>
          {tasks.map(task => (
            <button
              key={task.id}
              type="button"
              className={clsx(css.taskItem, selectedId === task.id && css.taskItemActive)}
              onClick={() => { setSelectedId(task.id) }}
            >
              <div className={css.taskName}>{task.name ?? task.id}</div>
              <div className={css.taskTime}>{task.createTime}</div>
            </button>
          ))}
        </div>
      </div>

      <div className={css.detail}>
        {selectedTask == null ? (
          <div className={css.empty}>请选择左侧待办</div>
        ) : (
          <>
            <div className={css.detailHeader}>
              <h2 className={css.detailTitle}>{selectedTask.name ?? selectedTask.id}</h2>
              <div className={css.detailMeta}>
                流程实例: {selectedTask.processInstanceId}
              </div>
            </div>

            {selectedTask.dshMeta?.skillRefs != null && selectedTask.dshMeta.skillRefs.length > 0 && (
              <div className={css.skillRow}>
                <span className={css.skillLabel}>技能引用:</span>
                {selectedTask.dshMeta.skillRefs.map(skill => (
                  <span key={skill} className={css.skillTag}>{skill}</span>
                ))}
              </div>
            )}

            <div className={css.promptSection}>
              <div className={css.sectionHeader}>
                <span className={css.sectionTitle}>任务指令</span>
                <Button variant="outline" onClick={() => { void handleCopyPrompt() }}>
                  复制到剪贴板
                </Button>
              </div>
              <div className={css.promptBody}>
                {selectedTask.dshMeta?.userPrompt != null ? (
                  <MarkdownText text={selectedTask.dshMeta.userPrompt} />
                ) : (
                  <div className={css.hint}>无任务指令</div>
                )}
              </div>
            </div>

            <div className={css.jsonSection}>
              <div className={css.sectionHeader}>
                <span className={css.sectionTitle}>AI 输出 JSON</span>
                <span className={css.hint}>将 AI 对话生成的 JSON 粘贴到此处</span>
              </div>
              <textarea
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value) }}
                placeholder="{ ... }"
                className={css.jsonInput}
                rows={10}
              />
            </div>

            <div className={css.detailActions}>
              <Button
                onClick={() => { setShowDialog(true) }}
                disabled={jsonText.trim() === '' || submitting}
              >
                提交待办
              </Button>
            </div>
          </>
        )}
      </div>

      {showDialog && selectedTask != null && (
        <TaskSubmitDialog
          open={showDialog}
          task={selectedTask}
          jsonText={jsonText}
          submitting={submitting}
          submitError={error}
          onClose={() => { setShowDialog(false); setError(null) }}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  )
}
