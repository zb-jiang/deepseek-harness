import { ArrowLeftOutlined, CheckOutlined, StopOutlined } from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  instancesApi,
  type ProcessInstanceDto,
  type TaskDto,
} from '../api/process-instances'
import { workflowsApi, type WorkflowDefinitionDto } from '../api/workflows'

const TASK_STATUS_COLOR: Record<string, string> = {
  active: 'blue',
  completed: 'default',
}

export default function InstanceDetailPage() {
  const { instanceId = '' } = useParams()
  const [searchParams] = useSearchParams()

  // 当访问 /instances/new?workflowId=xxx 时,渲染新建实例表单
  if (instanceId === 'new') {
    const workflowId = searchParams.get('workflowId')
    if (!workflowId) {
      return (
        <Alert
          type="error"
          message="缺少 workflowId 参数"
          description={'请从流程定义列表的"发起"按钮进入。'}
          showIcon
        />
      )
    }
    return <InstanceStartForm workflowId={workflowId} />
  }

  return <InstanceDetailView instanceId={instanceId} />
}

function InstanceStartForm({ workflowId }: { workflowId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [wf, setWf] = useState<WorkflowDefinitionDto | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{
    businessKey?: string
    name?: string
    variablesJson?: string
  }>()

  useEffect(() => {
    void (async () => {
      try {
        const data = await workflowsApi.get(workflowId)
        setWf(data)
        if (data.status !== 'published') {
          message.error(`流程当前状态为 ${data.status},不可发起`)
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message : '加载流程定义失败')
      }
    })()
  }, [workflowId, message])

  const submit = async () => {
    const values = await form.validateFields()
    let variables: Record<string, unknown> | undefined
    if (values.variablesJson?.trim()) {
      try {
        variables = JSON.parse(values.variablesJson)
      } catch {
        message.error('变量 JSON 解析失败,请检查格式')
        return
      }
    }
    setSubmitting(true)
    try {
      const instance = await instancesApi.start({
        workflowDefinitionId: workflowId,
        businessKey: values.businessKey || undefined,
        name: values.name || undefined,
        variables,
      })
      message.success(`已启动实例 ${instance.id}`)
      navigate(`/instances/${instance.id}`, { replace: true })
    } catch (e) {
      message.error(e instanceof Error ? e.message : '启动失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!wf) {
    return <Typography.Text type="secondary">加载流程定义...</Typography.Text>
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflows')}>
          返回流程定义
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          发起实例:{wf.name}
        </Typography.Title>
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: '流程定义 ID', children: wf.id },
          { key: 'name', label: '名称', children: wf.name },
          {
            key: 'status',
            label: '状态',
            children: <Tag color={wf.status === 'published' ? 'green' : 'default'}>{wf.status}</Tag>,
          },
          { key: 'procdefId', label: 'procdefId', children: wf.publishedProcdefId ?? '-' },
        ]}
      />

      <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
        <Form.Item name="businessKey" label="业务键">
          <Input placeholder="如订单号(可空)" />
        </Form.Item>
        <Form.Item name="name" label="实例名">
          <Input placeholder="便于查找的实例名(可空)" />
        </Form.Item>
        <Form.Item name="variablesJson" label="业务变量(JSON)">
          <Input.TextArea
            rows={6}
            placeholder='{"order_id": "ORD001", "amount": 1000}'
            style={{ fontFamily: 'monospace' }}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          应用隔离三变量(dsh_applicant_user_id / dsh_app_id / dsh_workflow_definition_id)由后端自动注入,不需要填写。
        </Typography.Paragraph>
        <Form.Item>
          <Button type="primary" loading={submitting} onClick={submit}>
            启动实例
          </Button>
        </Form.Item>
      </Form>
    </div>
  )
}

function InstanceDetailView({ instanceId }: { instanceId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()

  const [inst, setInst] = useState<ProcessInstanceDto | null>(null)
  const [tasks, setTasks] = useState<TaskDto[]>([])
  const [loading, setLoading] = useState(false)
  const [terminateOpen, setTerminateOpen] = useState(false)
  const [terminateForm] = Form.useForm<{ reason?: string }>()
  const [completeTarget, setCompleteTarget] = useState<TaskDto | null>(null)
  const [completeForm] = Form.useForm<{ variablesJson?: string }>()
  const [completing, setCompleting] = useState(false)

  const load = useCallback(async () => {
    if (!instanceId) return
    setLoading(true)
    try {
      const [instance, taskList] = await Promise.all([
        instancesApi.get(instanceId),
        instancesApi.listTasks(instanceId),
      ])
      setInst(instance)
      setTasks(taskList ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载实例失败')
    } finally {
      setLoading(false)
    }
  }, [instanceId, message])

  useEffect(() => {
    void load()
  }, [load])

  const submitTerminate = async () => {
    if (!inst) return
    const values = await terminateForm.validateFields()
    try {
      await instancesApi.terminate(inst.id, values.reason || undefined)
      message.success('已终止实例')
      setTerminateOpen(false)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '终止失败')
    }
  }

  const submitComplete = async () => {
    if (!inst || !completeTarget) return
    const values = await completeForm.validateFields()
    let variables: Record<string, unknown> | undefined
    if (values.variablesJson?.trim()) {
      try {
        variables = JSON.parse(values.variablesJson)
      } catch {
        message.error('变量 JSON 解析失败')
        return
      }
    }
    setCompleting(true)
    try {
      await instancesApi.completeTask(inst.id, completeTarget.id, { variables })
      message.success(`已完成任务 ${completeTarget.name ?? completeTarget.id}`)
      setCompleteTarget(null)
      completeForm.resetFields()
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '完成任务失败')
    } finally {
      setCompleting(false)
    }
  }

  const taskColumns: ColumnsType<TaskDto> = [
    { title: '任务 ID', dataIndex: 'id', key: 'id', render: v => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
    { title: '任务名', dataIndex: 'name', key: 'name', render: (v: string | null) => v ?? '-' },
    { title: '节点 key', dataIndex: 'taskDefinitionKey', key: 'taskDefinitionKey' },
    { title: '办理人', dataIndex: 'assignee', key: 'assignee', render: (v: string | null) => v ?? '-' },
    { title: 'owner', dataIndex: 'owner', key: 'owner', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, task) => <Tag color={TASK_STATUS_COLOR.active}>{task.assignee ? '待办理' : '待 claim'}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, task) => (
        <Button
          size="small"
          type="link"
          icon={<CheckOutlined />}
          onClick={() => {
            completeForm.resetFields()
            setCompleteTarget(task)
          }}
        >
          完成
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/instances')}>
          返回列表
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          实例详情
        </Typography.Title>
        {inst && !inst.ended && (
          <Popconfirm title="确认终止实例?" onConfirm={() => setTerminateOpen(true)}>
            <Button danger icon={<StopOutlined />}>终止</Button>
          </Popconfirm>
        )}
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: '实例 ID', children: <Typography.Text code>{inst?.id ?? '-'}</Typography.Text> },
          { key: 'name', label: '实例名', children: inst?.name ?? '-' },
          { key: 'workflowName', label: '流程名', children: inst?.workflowName ?? inst?.processDefinitionName ?? '-' },
          { key: 'businessKey', label: '业务键', children: inst?.businessKey ?? '-' },
          { key: 'procdefId', label: 'procdefId', children: inst?.processDefinitionId ?? '-' },
          { key: 'startUserId', label: '发起人', children: inst?.startUserId ?? '-' },
          {
            key: 'startTime',
            label: '启动时间',
            children: inst?.startTime ? dayjs(inst.startTime).format('YYYY-MM-DD HH:mm:ss') : '-',
          },
          {
            key: 'status',
            label: '状态',
            children: inst ? (
              inst.ended ? (
                <Tag color={inst.deleteReason ? 'red' : 'green'}>{inst.deleteReason ? '已终止' : '已完成'}</Tag>
              ) : (
                <Tag color={inst.suspended ? 'orange' : 'blue'}>{inst.suspended ? '已挂起' : '运行中'}</Tag>
              )
            ) : '-',
          },
          {
            key: 'endTime',
            label: '结束时间',
            children: inst?.endTime ? dayjs(inst.endTime).format('YYYY-MM-DD HH:mm:ss') : '-',
          },
          {
            key: 'deleteReason',
            label: '终止原因',
            children: inst?.deleteReason ?? '-',
          },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>任务列表</Typography.Title>
      <Table<TaskDto>
        rowKey="id"
        columns={taskColumns}
        dataSource={tasks}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 800 }}
      />

      <Modal
        title="终止实例"
        open={terminateOpen}
        onCancel={() => setTerminateOpen(false)}
        onOk={submitTerminate}
        destroyOnClose
      >
        <Form form={terminateForm} layout="vertical">
          <Form.Item name="reason" label="终止原因">
            <Input.TextArea rows={3} placeholder="可空" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={completeTarget ? `完成任务: ${completeTarget.name ?? completeTarget.id}` : '完成任务'}
        open={!!completeTarget}
        onCancel={() => setCompleteTarget(null)}
        onOk={submitComplete}
        confirmLoading={completing}
        destroyOnClose
      >
        <Form form={completeForm} layout="vertical">
          <Form.Item name="variablesJson" label="完成变量(JSON)">
            <Input.TextArea
              rows={6}
              placeholder='{"approved": true, "comment": "通过"}'
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            V1 Web Console 仅做端到端联调;真正输出校验(ajv)+ 缺项回喂在 DSH enterprise profile 中。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
