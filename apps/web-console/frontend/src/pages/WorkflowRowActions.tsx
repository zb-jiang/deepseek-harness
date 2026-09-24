import { PlayCircleOutlined } from '@ant-design/icons'
import { App, Button, Modal, Popconfirm, Space, Tag } from 'antd'
import { useNavigate } from 'react-router-dom'
import { type WorkflowDefinitionDto, workflowsApi } from '../api/workflows'

export const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  published: 'green',
  disabled: 'orange',
  archived: 'red',
}

export const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  disabled: '已停用',
  archived: '已归档',
}

export function WorkflowStatusTag({ status }: { status: string }) {
  return <Tag color={STATUS_COLOR[status] ?? 'default'}>{STATUS_TEXT[status] ?? status}</Tag>
}

/**
 * 流程定义行内操作按钮组(编辑/校验/发布/发起/停用/归档),供流程定义列表页与应用详情页签共用。
 * onChanged 在任一操作成功改变流程状态后回调,由调用方刷新列表。
 */
export default function WorkflowRowActions({ wf, onChanged }: { wf: WorkflowDefinitionDto; onChanged: () => void }) {
  const { message } = App.useApp()
  const navigate = useNavigate()

  const handleValidate = async () => {
    try {
      const result = await workflowsApi.validate(wf.id)
      if (result.valid) {
        message.success('BPMN 校验通过')
      } else {
        Modal.error({
          title: 'BPMN 校验失败',
          content: (
            <ul style={{ paddingLeft: 20, maxHeight: 300, overflow: 'auto' }}>
              {result.errors.map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          ),
        })
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '校验失败')
    }
  }

  const handlePublish = async () => {
    try {
      const result = await workflowsApi.publish(wf.id)
      message.success(`已发布 (deployment=${result.deploymentId}, procdef=${result.procdefId})`)
      onChanged()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '发布失败')
    }
  }

  const handleDisable = async () => {
    try {
      await workflowsApi.disable(wf.id)
      message.success(`已停用 ${wf.name}`)
      onChanged()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '停用失败')
    }
  }

  const handleArchive = async () => {
    try {
      await workflowsApi.archive(wf.id)
      message.success(`已归档 ${wf.name}`)
      onChanged()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '归档失败')
    }
  }

  return (
    <Space size="small" wrap>
      <Button size="small" type="link" onClick={() => navigate(`/workflows/${wf.id}`)}>
        编辑
      </Button>
      {wf.status === 'draft' && (
        <Button size="small" type="link" onClick={handleValidate}>
          校验
        </Button>
      )}
      {(wf.status === 'draft' || wf.status === 'disabled') && (
        <Popconfirm title={`发布 ${wf.name}?`} onConfirm={handlePublish}>
          <Button size="small" type="link">发布</Button>
        </Popconfirm>
      )}
      {wf.status === 'published' && (
        <>
          <Button
            size="small"
            type="link"
            icon={<PlayCircleOutlined />}
            onClick={() => navigate(`/instances/new?workflowId=${wf.id}`)}
          >
            发起
          </Button>
          <Popconfirm title={`停用 ${wf.name}?`} onConfirm={handleDisable}>
            <Button size="small" type="link" danger>停用</Button>
          </Popconfirm>
        </>
      )}
      {wf.status !== 'archived' && (
        <Popconfirm title={`归档 ${wf.name}?此操作不可撤销`} onConfirm={handleArchive}>
          <Button size="small" type="link" danger>归档</Button>
        </Popconfirm>
      )}
    </Space>
  )
}
