import { ArrowLeftOutlined, CheckOutlined, StopOutlined } from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
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
  type HistoricActivityDto,
  type ProcessInstanceDto,
  type ProcessVariableDto,
  type StartFormVariableDto,
  type TaskDto,
} from '../api/process-instances'
import { workflowsApi, type WorkflowDefinitionDto } from '../api/workflows'
import BpmnHistoryViewer from '../bpmn/BpmnHistoryViewer'

/** 历史活动类型 → 中文名(路径图时间线展示用;未映射的类型原样显示)。 */
const ACTIVITY_TYPE_TEXT: Record<string, string> = {
  startEvent: '开始事件',
  endEvent: '结束事件',
  userTask: '用户任务',
  serviceTask: '服务任务',
  sendTask: '发送任务',
  receiveTask: '接收任务',
  manualTask: '手工任务',
  businessRuleTask: '业务规则任务',
  scriptTask: '脚本任务',
  callActivity: '调用活动',
  exclusiveGateway: '排他网关',
  parallelGateway: '并行网关',
  inclusiveGateway: '包容网关',
  eventBasedGateway: '事件网关',
  sequenceFlow: '连线',
}

/** 活动耗时(毫秒)→ 人读时长。 */
function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分钟`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}小时${rm}分` : `${h}小时`
}

/** 变量值 → 展示文本(对象/数组 pretty JSON;字符串原样)。 */
function formatVariableValue(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
  return String(v)
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
  const [startVars, setStartVars] = useState<StartFormVariableDto[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<Record<string, unknown>>()

  useEffect(() => {
    void (async () => {
      try {
        const data = await workflowsApi.get(workflowId)
        setWf(data)
        if (data.status !== 'published') {
          message.error(`流程当前状态为 ${data.status},不可发起`)
          return
        }
        // 启动表单变量清单(已部署 BPMN 的 start-param 声明)
        setStartVars(await instancesApi.startForm(workflowId))
      } catch (e) {
        message.error(e instanceof Error ? e.message : '加载流程定义失败')
      }
    })()
  }, [workflowId, message])

  const submit = async () => {
    const values = await form.validateFields()
    // 按 start-param 声明组装变量:空值不传(由后端 initial 兜底),object/array 解析 JSON
    const variables: Record<string, unknown> = {}
    let parseError = false
    for (const v of startVars) {
      const raw = values[v.name]
      if (raw === undefined || raw === null || raw === '') continue
      if (v.type === 'object' || v.type === 'array') {
        try {
          variables[v.name] = JSON.parse(raw as string)
        } catch {
          message.error(`变量 ${v.name} 不是合法的 JSON`)
          parseError = true
        }
      } else if (v.type === 'boolean') {
        variables[v.name] = raw === true || raw === 'true'
      } else {
        variables[v.name] = raw
      }
    }
    if (parseError) return
    setSubmitting(true)
    try {
      const instance = await instancesApi.start({
        workflowDefinitionId: workflowId,
        businessKey: (values.businessKey as string) || undefined,
        name: (values.name as string) || undefined,
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
        {startVars.map(v => (
          <Form.Item
            key={v.name}
            name={v.name}
            label={`${v.name} (${v.type})`}
            tooltip={v.description ?? undefined}
            rules={v.required ? [{ required: true, message: `请输入 ${v.name}` }] : undefined}
          >
            {renderStartParamInput(v.type)}
          </Form.Item>
        ))}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          表单项由流程的上下文声明(start-param)自动生成;未声明变量会被后端拒绝。
          应用隔离三变量(dsh_applicant_user_id / dsh_app_id / dsh_workflow_definition_id)由后端自动注入。
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

/** 按声明类型渲染 start-param 输入控件。 */
function renderStartParamInput(type: string) {
  switch (type) {
    case 'integer':
    case 'float':
      return <InputNumber style={{ width: '100%' }} placeholder={type === 'integer' ? '整数' : '小数'} />
    case 'boolean':
      return (
        <Select
          allowClear
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
        />
      )
    case 'date':
      return <Input placeholder="yyyy-MM-dd,如 2026-01-31" />
    case 'datetime':
      return <Input placeholder="ISO-8601,如 2026-01-31T09:30:00" />
    case 'object':
    case 'array':
      return <Input.TextArea rows={3} placeholder='JSON 文本,如 {"k":"v"}' style={{ fontFamily: 'monospace' }} />
    default:
      return <Input placeholder="字符串" />
  }
}

function InstanceDetailView({ instanceId }: { instanceId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()

  const [inst, setInst] = useState<ProcessInstanceDto | null>(null)
  const [tasks, setTasks] = useState<TaskDto[]>([])
  const [variables, setVariables] = useState<ProcessVariableDto[]>([])
  const [activities, setActivities] = useState<HistoricActivityDto[]>([])
  const [bpmnXml, setBpmnXml] = useState('')
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
      // 概要/任务失败提示;变量/活动/图属于历史视图,拉不到时优雅降级为空
      const [instance, taskList, varList, actList, xml] = await Promise.all([
        instancesApi.get(instanceId),
        instancesApi.listTasks(instanceId),
        instancesApi.listVariables(instanceId).catch(() => [] as ProcessVariableDto[]),
        instancesApi.listActivities(instanceId).catch(() => [] as HistoricActivityDto[]),
        instancesApi.getBpmnXml(instanceId).catch(() => ''),
      ])
      setInst(instance)
      setTasks(taskList ?? [])
      setVariables(varList ?? [])
      setActivities(actList ?? [])
      setBpmnXml(xml ?? '')
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
    { title: '办理人', dataIndex: 'assigneeName', key: 'assigneeName', render: (v: string | null, task: TaskDto) => v ?? task.assignee ?? '-' },
    { title: 'owner', dataIndex: 'owner', key: 'owner', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '完成时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, task) => {
        if (task.endTime) {
          return <Tag color={task.deleteReason ? 'red' : 'default'}>{task.deleteReason ? '已终止' : '已完成'}</Tag>
        }
        return <Tag color="blue">{task.assignee ? '待办理' : '待 claim'}</Tag>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, task) =>
        task.endTime ? null : (
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

  const activityColumns: ColumnsType<HistoricActivityDto> = [
    {
      title: '节点',
      key: 'activityName',
      render: (_, act) => act.activityName ?? act.activityId,
    },
    {
      title: '类型',
      dataIndex: 'activityType',
      key: 'activityType',
      render: (v: string) => ACTIVITY_TYPE_TEXT[v] ?? v,
    },
    {
      title: '处理人',
      dataIndex: 'assigneeName',
      key: 'assigneeName',
      render: (v: string | null, act: HistoricActivityDto) => v ?? act.assignee ?? '-',
    },
    {
      title: '开始时间',
      dataIndex: 'startTime',
      key: 'startTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '结束时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '耗时',
      dataIndex: 'durationInMillis',
      key: 'durationInMillis',
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, act) =>
        act.endTime ? <Tag color="green">已完成</Tag> : <Tag color="blue">进行中</Tag>,
    },
  ]

  const variableColumns: ColumnsType<ProcessVariableDto> = [
    { title: '变量名', dataIndex: 'name', key: 'name', render: v => <Typography.Text code>{v}</Typography.Text> },
    { title: '类型', dataIndex: 'type', key: 'type', render: (v: string | null) => v ?? '-' },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      render: (v: unknown) => (
        <Typography.Text
          style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}
        >
          {formatVariableValue(v)}
        </Typography.Text>
      ),
    },
    {
      title: '最后更新',
      dataIndex: 'lastUpdatedTime',
      key: 'lastUpdatedTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
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
          { key: 'startUserId', label: '发起人', children: inst?.startUserName ?? inst?.startUserId ?? '-' },
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

      <Typography.Title level={5} style={{ marginTop: 24 }}>历史活动路径</Typography.Title>
      {bpmnXml ? (
        <>
          <Space style={{ marginBottom: 8 }} size={16}>
            <span>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#d9f7be', border: '2px solid #52c41a', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />
              已完成
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#bae0ff', border: '2px solid #1677ff', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />
              进行中
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2.5px solid #52c41a', marginRight: 4, verticalAlign: 3 }} />
              已走过连线
            </span>
          </Space>
          <BpmnHistoryViewer xml={bpmnXml} activities={activities} />
        </>
      ) : (
        <Alert
          type="info"
          showIcon
          message="未获取到部署版 BPMN XML,无法渲染活动路径图"
          description="旧版本部署可能已被新发布覆盖;活动时间线仍可用。"
          style={{ marginBottom: 16 }}
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 24, fontSize: 14 }}>活动时间线</Typography.Title>
      <Table<HistoricActivityDto>
        rowKey="id"
        columns={activityColumns}
        dataSource={activities}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>任务列表</Typography.Title>
      <Table<TaskDto>
        rowKey="id"
        columns={taskColumns}
        dataSource={tasks}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>流程变量</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        运行中实例显示当前值;已结束实例显示终值。dsh_* 前缀为系统注入的应用隔离与身份变量。
      </Typography.Paragraph>
      <Table<ProcessVariableDto>
        rowKey="name"
        columns={variableColumns}
        dataSource={variables}
        loading={loading}
        pagination={false}
        size="small"
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
          <Typography.Paragraph type="warning" style={{ fontSize: 12 }}>
            管理员强制完成：不经过员工端 AI 对话与输出映射校验，直接调用引擎 complete 任务。
            仅用于端到端联调或管理员干预，正式办理请通过 DSH 员工端「我的待办」提交。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
