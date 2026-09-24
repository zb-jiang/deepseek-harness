import { PartitionOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Form, Input, Modal, Select, Space, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { type ApplicationDto, appsApi } from '../api/apps'
import {
  type CreateWorkflowRequest,
  type WorkflowDefinitionDto,
  workflowsApi,
} from '../api/workflows'
import WorkflowRowActions, { STATUS_TEXT, WorkflowStatusTag } from './WorkflowRowActions'

export default function WorkflowsPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [data, setData] = useState<WorkflowDefinitionDto[]>([])
  const [apps, setApps] = useState<ApplicationDto[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [appIdFilter, setAppIdFilter] = useState<string | undefined>(
    searchParams.get('appId') ?? undefined,
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<CreateWorkflowRequest>()

  const appMap = useMemo(() => {
    const m = new Map<string, ApplicationDto>()
    for (const a of apps) m.set(a.id, a)
    return m
  }, [apps])

  const loadApps = useCallback(async () => {
    try {
      const list = await appsApi.list({ limit: 500 })
      setApps(list ?? [])
    } catch (e) {
      console.warn('[workflows] load apps failed', e)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await workflowsApi.list({
        appId: appIdFilter,
        status: statusFilter,
        limit: 500,
      })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载流程定义失败')
    } finally {
      setLoading(false)
    }
  }, [appIdFilter, statusFilter, message])

  useEffect(() => {
    void loadApps()
  }, [loadApps])

  useEffect(() => {
    void load()
  }, [load])

  const submitCreate = async () => {
    const values = await createForm.validateFields()
    try {
      const created = await workflowsApi.create(values)
      message.success(`已创建流程 ${created.name}`)
      setCreateOpen(false)
      createForm.resetFields()
      navigate(`/workflows/${created.id}`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    }
  }

  const appOptions = apps.map(a => ({ label: a.name, value: a.id }))

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
      title: '所属应用',
      dataIndex: 'appId',
      key: 'appId',
      render: (v: string) => appMap.get(v)?.name ?? v.slice(0, 8),
    },
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
        <Typography.Title level={4} style={{ margin: 0 }}>
          <PartitionOutlined /> 流程定义
        </Typography.Title>
        <Select
          allowClear
          placeholder="按应用过滤"
          style={{ width: 200 }}
          value={appIdFilter}
          onChange={v => setAppIdFilter(v)}
          options={appOptions}
          showSearch
          optionFilterProp="label"
        />
        <Select
          allowClear
          placeholder="按状态过滤"
          style={{ width: 140 }}
          value={statusFilter}
          onChange={v => setStatusFilter(v)}
          options={Object.entries(STATUS_TEXT).map(([k, v]) => ({ label: v, value: k }))}
        />
        <Button onClick={() => load()}>刷新</Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          disabled={appOptions.length === 0}
        >
          新建流程
        </Button>
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
            name="appId"
            label="所属应用"
            rules={[{ required: true, message: '请选择应用' }]}
          >
            <Select options={appOptions} placeholder="选择应用" showSearch optionFilterProp="label" />
          </Form.Item>
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
