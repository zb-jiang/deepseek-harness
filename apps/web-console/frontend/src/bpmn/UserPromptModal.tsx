/**
 * User Prompt 统一编辑弹窗。
 *
 * <p>按 design 2026-09-01 要求,User Prompt 是一段格式化的完整任务指令;
 * 输出 JSON 格式、变量占位符、输出映射应在同一编辑界面内完成,因为它们
 * 共享同一个上下文("AI 要输出什么 JSON,这个 JSON 又怎么写回流程变量")。
 *
 * <p>弹窗布局:
 * - 左侧:User Prompt 大文本编辑区;
 * - 右侧:输出映射表 + 快速插入(变量占位符 / JSON 骨架);
 * - 底部:预览区(插值预览 / 输出映射摘要)。
 */
import {
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import type { Entry } from '@bpmn-io/properties-panel'
import {
  Button,
  Card,
  Input,
  List,
  Select,
  Space,
  Tabs,
  TreeSelect,
  Typography,
  Modal,
} from 'antd'
import type { InputRef } from 'antd'
import { h } from 'preact'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BpmnElement,
  BpmnModdleElement,
  Injector,
  ModelingService,
  ModdleService,
} from './DshPropertiesProvider'
import {
  buildContextPaths,
  ensureExtensionElements,
  findDshElement,
  getDshText,
  readContextDeclarations,
  removeDshElement,
  upsertDshElement,
} from './DshPropertiesProvider'

const { TextArea } = Input
const { Text } = Typography

/** 标量的骨架占位值(date/datetime 给格式示例,数值给零值,其余留空串)。 */
function scalarSkeleton(type: string): unknown {
  switch (type) {
    case 'integer':
    case 'float':
      return 0
    case 'boolean':
      return false
    case 'date':
      return '2026-01-31'
    case 'datetime':
      return '2026-01-31T09:30:00'
    default:
      return ''
  }
}

/** object 骨架:按字段清单递归(未命名字段跳过;array 字段出空数组)。 */
function objectSkeleton(fields: BpmnModdleElement[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const name = ((f.get('name') as string) ?? '').trim()
    if (!name) continue
    const ftype = (f.get('type') as string) ?? 'string'
    out[name] = ftype === 'object'
      ? objectSkeleton((f.get('field') as BpmnModdleElement[]) ?? [])
      : ftype === 'array'
        ? []
        : scalarSkeleton(ftype)
  }
  return out
}

export interface UserPromptModalProps {
  element: BpmnElement
  injector: Injector
}

/** 输出映射的本地编辑态。 */
interface LocalMapping {
  source: string
  target: string
  key: string
}

/** 读取元素当前 outputMappings 为本地态。 */
function readMappings(element: BpmnElement): LocalMapping[] {
  const container = findDshElement(element, 'dsh:OutputMappings')
  if (!container) return []
  const items = (container.get('mapping') as BpmnModdleElement[]) ?? []
  return items.map((m, idx) => ({
    source: (m.get('source') as string) ?? '',
    target: (m.get('target') as string) ?? '',
    key: `${idx}-${m.$type}`,
  }))
}

/** 插值预览:把 {{变量.字段}} 替换为可读的占位标记。 */
function previewInterpolated(text: string): string {
  return text.replace(/\{\{([^}]+)}}/g, (_, path) => `[${path.trim()}]`)
}

/** TreeSelect 用的变量字段树节点。 */
type VariableTreeNode = {
  value: string
  title: string
  children?: VariableTreeNode[]
}

/** 构建变量字段树,供 TreeSelect 展示。 */
function buildVariableTree(injector: Injector): VariableTreeNode[] {
  const out: VariableTreeNode[] = []
  for (const v of readContextDeclarations(injector)) {
    const name = ((v.get('name') as string) ?? '').trim()
    const type = (v.get('type') as string) ?? 'string'
    if (!name) continue
    out.push({
      value: name,
      title: `${name} (${type})`,
      children: type === 'object' ? buildFieldTree(v, name) : undefined,
    })
  }
  return out
}

function buildFieldTree(container: BpmnModdleElement, prefix: string): VariableTreeNode[] {
  const fields = (container.get('field') as BpmnModdleElement[]) ?? []
  return fields
    .map((f) => {
      const name = ((f.get('name') as string) ?? '').trim()
      const type = (f.get('type') as string) ?? 'string'
      if (!name) return null
      const path = `${prefix}.${name}`
      return {
        value: path,
        title: `${name} (${type})`,
        children: type === 'object' ? buildFieldTree(f, path) : undefined,
      }
    })
    .filter(Boolean) as VariableTreeNode[]
}

/** 按类型生成单个占位值(object 递归字段,array 出空数组)。 */
function typePlaceholder(type: string, element: BpmnModdleElement): unknown {
  switch (type) {
    case 'integer':
    case 'float':
      return 0
    case 'boolean':
      return false
    case 'date':
      return '2026-01-31'
    case 'datetime':
      return '2026-01-31T09:30:00'
    case 'object':
      return objectSkeleton((element.get('field') as BpmnModdleElement[]) ?? [])
    case 'array':
      return []
    default:
      return ''
  }
}

/** 根据 target 点路径(如 A.1)找到对应的类型,并返回占位值。 */
function placeholderForTarget(target: string, injector: Injector): unknown {
  const parts = target.split('.')
  const rootName = parts[0]
  let variable = readContextDeclarations(injector).find(
    v => ((v.get('name') as string) ?? '').trim() === rootName,
  )
  if (!variable) return ''

  let current: BpmnModdleElement = variable
  let type = (variable.get('type') as string) ?? 'string'
  for (let i = 1; i < parts.length && variable; i++) {
    if (type === 'object') {
      const fields = (current.get('field') as BpmnModdleElement[]) ?? []
      const field = fields.find(f => (f.get('name') as string) === parts[i])
      if (!field) return ''
      current = field
      type = (field.get('type') as string) ?? 'string'
    } else if (type === 'array') {
      // 数组索引路径,取元素类型作为后续类型;不再按索引深入字段树
      type = (current.get('itemType') as string) ?? 'string'
    } else {
      return ''
    }
  }
  return typePlaceholder(type, current)
}

/** 在对象上按点路径设置值(自动创建中间对象)。 */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof current[p] !== 'object' || current[p] === null) {
      current[p] = {}
    }
    current = current[p] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/**
 * 根据输出映射生成 JSON 骨架。
 *
 * <p>source 非空时,骨架 key 就是 source 路径(员工按此 JSON 字段提交);
 * source 为空时,表示整体提交,按 target 指向的上下文变量结构生成整体 JSON。
 */
function buildSkeletonFromMappings(
  mappings: LocalMapping[],
  injector: Injector,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const valid = mappings.filter(m => m.target.trim())

  // 1) source 为空的映射:整体提交,按 target 变量结构生成
  for (const m of valid.filter(m => !m.source.trim())) {
    const rootName = m.target.split('.')[0]
    const variable = readContextDeclarations(injector).find(
      v => ((v.get('name') as string) ?? '').trim() === rootName,
    )
    if (!variable) continue
    const name = ((variable.get('name') as string) ?? '').trim()
    const type = (variable.get('type') as string) ?? 'string'
    result[name] = type === 'object'
      ? objectSkeleton((variable.get('field') as BpmnModdleElement[]) ?? [])
      : type === 'array'
        ? [typePlaceholder((variable.get('itemType') as string) ?? 'string', variable)]
        : typePlaceholder(type, variable)
  }

  // 2) source 非空的映射:source 路径作为 JSON key,target 类型决定占位值
  for (const m of valid.filter(m => m.source.trim())) {
    setPath(result, m.source.trim(), placeholderForTarget(m.target, injector))
  }

  return result
}

/** React 弹窗内容组件(由 ReactDOM.createRoot 渲染在 document.body,独立于 properties panel 的 preact 树)。 */
function UserPromptModalContent({
  element,
  injector,
  onClose,
}: UserPromptModalProps & { onClose: () => void }): React.ReactElement {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')

  const [text, setText] = useState('')
  const [mappings, setMappings] = useState<LocalMapping[]>([])
  const textareaRef = useRef<InputRef>(null)

  // 弹窗创建时即把当前 element 的值载入本地态
  useEffect(() => {
    setText(getDshText(element, 'dsh:UserPrompt'))
    setMappings(readMappings(element))
  }, [element])

  // 是否有至少一条配置了 target 的输出映射(用于启用 JSON 骨架按钮)
  const hasSkeletonTarget = useMemo(
    () => mappings.some(m => m.target.trim()),
    [mappings],
  )

  const updateMapping = (idx: number, field: keyof LocalMapping, value: string) => {
    setMappings((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  const addMapping = () => {
    setMappings(prev => [
      ...prev,
      { source: '', target: '', key: `${Date.now()}-${Math.random()}` },
    ])
  }

  const removeMapping = (idx: number) => {
    setMappings(prev => prev.filter((_, i) => i !== idx))
  }

  /** 获取底层 textarea DOM 元素(antd Input.TextArea 的 ref 封装了一层)。 */
  const getTextAreaElement = (): HTMLTextAreaElement | null => {
    const input = textareaRef.current
    if (!input) return null
    return (
      (input as unknown as { resizableTextArea?: { textArea?: HTMLTextAreaElement } }).resizableTextArea
        ?.textArea ?? null
    )
  }

  /** 在当前光标位置(或选区)插入内容;插入后恢复光标到内容末尾。 */
  const insertAtCursor = (content: string) => {
    const el = getTextAreaElement()
    if (!el) {
      // 兜底:若拿不到 textarea,直接追加到末尾
      setText(prev => prev + content)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const before = text.slice(0, start)
    const after = text.slice(end)
    const next = `${before}${content}${after}`
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + content.length
      el.setSelectionRange(pos, pos)
    })
  }

  const insertVariable = (path: string) => {
    if (!path) return
    insertAtCursor(`{{${path}}}`)
  }

  const insertSkeleton = () => {
    const body = buildSkeletonFromMappings(mappings, injector)
    if (Object.keys(body).length === 0) return
    const skeleton = `请以以下的JSON格式进行输出:\n${JSON.stringify(body, null, 2)}`
    insertAtCursor(skeleton)
  }

  /** 把本地态写回 BPMN model(走命令栈,支持撤销)。 */
  const save = () => {
    // 1. userPrompt
    if (text.trim()) {
      upsertDshElement(element, injector, 'dsh:UserPrompt', { text: text.trim() })
    } else {
      removeDshElement(element, injector, 'dsh:UserPrompt')
    }

    // 2. outputMappings
    const ext = ensureExtensionElements(element, injector)
    const values = (ext.get('values') as BpmnModdleElement[]) ?? []
    const kept = values.filter(v => v.$type !== 'dsh:OutputMappings')
    const valid = mappings.filter(m => m.target.trim())
    if (valid.length === 0) {
      modeling.updateModdleProperties(element, ext, { values: kept })
    } else {
      const mappingEls = valid.map(m =>
        moddle.create('dsh:Mapping', {
          source: m.source.trim() || undefined,
          target: m.target.trim(),
        }),
      )
      const container = moddle.create('dsh:OutputMappings', { mapping: mappingEls })
      modeling.updateModdleProperties(element, ext, { values: [...kept, container] })
    }

    onClose()
  }

  return (
    <Modal
      title="Bpmn:UserTask / User Prompt"
      open
      onCancel={onClose}
      width={1000}
      destroyOnClose={false}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={save}>
          保存到节点
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', gap: 16 }}>
        {/* 左侧:prompt 编辑区 */}
        <div style={{ flex: 1.25, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text strong>User Prompt</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            任务指令模板:角色、输入变量、应用 skill、任务要求、输出 JSON 格式均写在此;
            {'{{变量.字段}}'} 占位符会在任务创建时插值为流程变量快照。
          </Text>
          <TextArea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            rows={18}
            placeholder="例如:你当前的角色为审批专员,请基于申请摘要 {{upstream.summary}}..."
            style={{ fontFamily: 'system-ui, sans-serif', fontSize: 14, lineHeight: 1.6 }}
          />
        </div>

        {/* 右侧:输出映射 + 快速插入 */}
        <div style={{ flex: 0.75, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="默认输出映射" size="small" bodyStyle={{ padding: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仅作为员工端提交对话框的初始映射,员工提交前仍可修改;可为空。
            </Text>
            <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
              {mappings.map((m, idx) => (
                <Space key={m.key} style={{ display: 'flex', width: '100%' }} align="center">
                  <Input
                    placeholder="source"
                    value={m.source}
                    onChange={e => updateMapping(idx, 'source', e.target.value)}
                    style={{ width: 110 }}
                    title="提交 JSON 的顶层字段或点路径;留空 = 整体提交 JSON"
                  />
                  <Text type="secondary">→</Text>
                  <Select
                    placeholder="target"
                    value={m.target || undefined}
                    onChange={value => updateMapping(idx, 'target', value as string)}
                    options={buildContextPaths(injector)}
                    style={{ flex: 1, minWidth: 120 }}
                    allowClear
                  />
                  <Button
                    icon={<DeleteOutlined />}
                    size="small"
                    danger
                    onClick={() => removeMapping(idx)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                block
                size="small"
                icon={<PlusOutlined />}
                onClick={addMapping}
              >
                添加映射
              </Button>
            </Space>
          </Card>

          <Card title="快速插入" size="small" bodyStyle={{ padding: 12 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <TreeSelect
                treeData={buildVariableTree(injector)}
                placeholder="插入变量占位符"
                treeDefaultExpandAll={false}
                allowClear
                onChange={value => insertVariable(value as string)}
                style={{ width: '100%' }}
              />
              <Button
                block
                size="small"
                onClick={insertSkeleton}
                disabled={!hasSkeletonTarget}
                title={
                  hasSkeletonTarget
                    ? '按输出映射生成 JSON 骨架(source 非空用 source 作为 key,source 为空用 target 变量结构)'
                    : '请先配置至少一条输出映射'
                }
              >
                插入 JSON 骨架
              </Button>
            </Space>
          </Card>
        </div>
      </div>

      {/* 底部:预览 */}
      <Tabs
        style={{ marginTop: 16 }}
        size="small"
        items={[
          {
            key: 'interpolated',
            label: '插值预览',
            children: (
              <pre
                style={{
                  background: '#f6f6f6',
                  padding: 12,
                  borderRadius: 6,
                  maxHeight: 160,
                  overflow: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {previewInterpolated(text) || (
                  <Text type="secondary">暂无内容</Text>
                )}
              </pre>
            ),
          },
          {
            key: 'mappings',
            label: '输出映射摘要',
            children: (
              <List
                size="small"
                bordered
                dataSource={mappings.filter(m => m.target.trim())}
                renderItem={m => (
                  <List.Item>
                    <Text code>{m.source || '(整体 JSON)'}</Text>
                    <Text type="secondary"> → </Text>
                    <Text code>{m.target}</Text>
                  </List.Item>
                )}
                locale={{ emptyText: '未配置输出映射' }}
                style={{ maxHeight: 160, overflow: 'auto' }}
              />
            ),
          },
        ]}
      />
    </Modal>
  )
}

/** 在 document.body 上新建 React root 渲染弹窗;关闭时清理 root 与容器。 */
function openUserPromptModal(element: BpmnElement, injector: Injector): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const close = () => {
    root.unmount()
    container.remove()
  }
  root.render(
    <UserPromptModalContent element={element} injector={injector} onClose={close} />,
  )
}

/**
 * properties panel entry。
 *
 * <p>properties panel 内部运行 preact,不能在此直接渲染 React 组件(antd Modal 等)。
 * 因此 entry component 只渲染一个原生按钮;点击按钮后,在 document.body 上新建
 * React root 渲染弹窗内容,关闭时彻底清理,避免与 preact 树冲突。
 */
export function userPromptModalEntry(element: BpmnElement, injector: Injector): Entry {
  return {
    id: 'dsh-userPrompt-modal',
    component: () =>
      h('button', {
        className: 'bio-properties-panel-btn',
        style: { width: '100%', marginTop: 4, marginBottom: 4 },
        onClick: () => openUserPromptModal(element, injector),
      }, '编辑 User Prompt'),
  }
}
