import { PlusOutlined } from '@ant-design/icons'
import { App, Button, Form, Input, Modal, Space, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type CreateWorkflowRequest,
  type WorkflowDefinitionDto,
  workflowsApi,
} from '../api/workflows'
import WorkflowRowActions, { WorkflowStatusTag } from './WorkflowRowActions'

/**
 * 应用详情页「流程定义」页签:内嵌列出本应用的流程定义,并提供跳转流程定义菜单界面入口。
 */
export default function AppWorkflowsTab({ appId }: { appId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [data, setData] = useState<WorkflowDefinitionDto[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<Omit<CreateWorkflowRequest, 'appId'>>()

  const load = useCallback(async () => {
    if (!appId) return
    setLoading(true)
    try {
      const list = await workflowsApi.list({ appId, limit: 500 })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载流程定义失败')
    } finally {
      setLoading(false)
    }
  }, [appId, message])

  useEffect(() => {
    void load()
  }, [load])

  const submitCreate = async () => {
    const values = await createForm.validateFields()
    try {
      const created = await workflowsApi.create({ appId, ...values })
      message.success(`已创建流程 ${created.name}`)
      setCreateOpen(false)
      createForm.resetFields()
      navigate(`/workflows/${created.id}`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    }
  }

  const columns: ColumnsType<WorkflowDefinitionDto> = [
    {
      title: '流程名',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, wf) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/workflows/${wf.id}`)}>
          {v}
        </Button>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: v => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <WorkflowStatusTag status={v} />,
    },
    {
      title: 'procdefId',
      dataIndex: 'publishedProcdefId',
      key: 'publishedProcdefId',
      render: (v: string | null) =>
        v ? <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> : '-',
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_, wf) => <WorkflowRowActions wf={wf} onChanged={() => void load()} />,
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
        >
          新建流程
        </Button>
        <Button onClick={() => navigate(`/workflows?appId=${appId}`)}>打开流程定义菜单界面</Button>
        <Button onClick={() => load()}>刷新</Button>
      </Space>
      <Table<WorkflowDefinitionDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />
      <Modal
        title="新建流程定义"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        destroyOnClose
        width={520}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="name"
            label="流程名"
            rules={[{ required: true, message: '请输入流程名' }]}
          >
            <Input placeholder="应用内唯一" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="可空" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            创建后流程处于 draft 状态;在编辑页保存 BPMN XML、通过校验后可发布(spec §6.2)。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
