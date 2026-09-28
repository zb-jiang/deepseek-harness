import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import {
  App,
  Button,
  Card,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  type CreateModelRequest,
  type EnterpriseModelDto,
  llmApi,
  type UpdateModelRequest,
} from '../api/llm'

/** 企业模型表单值(新增/编辑共用) */
interface ModelFormValues {
  displayName: string
  gatewayModelName: string
  reservationTokens?: number
}

export default function LlmModelsPage() {
  const { message } = App.useApp()
  const [models, setModels] = useState<EnterpriseModelDto[]>([])
  const [loading, setLoading] = useState(false)
  const [modelTarget, setModelTarget] = useState<EnterpriseModelDto | null>(null)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [modelForm] = Form.useForm<ModelFormValues>()
  // 提交期间禁用 OK 按钮:防止用户重复点击造成重复写入
  const [submitting, setSubmitting] = useState(false)
  // New API 模型清单:网关模型名的合法取值源(新建时拉取,编辑时字段锁定无需拉取)
  const [newapiModels, setNewapiModels] = useState<string[]>([])
  const [newapiLoading, setNewapiLoading] = useState(false)
  const [newapiError, setNewapiError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const modelList = await llmApi.listModels()
      setModels(modelList ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  const loadNewapiModels = useCallback(async () => {
    setNewapiLoading(true)
    setNewapiError(null)
    try {
      const list = await llmApi.listNewapiModels()
      setNewapiModels(list ?? [])
    } catch (e) {
      setNewapiError(e instanceof Error ? e.message : '获取 New API 模型清单失败')
    } finally {
      setNewapiLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ---------- 企业模型 ----------

  const openModelCreate = () => {
    setModelTarget(null)
    setNewapiModels([])
    setNewapiError(null)
    setModelModalOpen(true)
    modelForm.setFieldsValue({
      displayName: '',
      gatewayModelName: '',
      reservationTokens: 0,
    })
    void loadNewapiModels()
  }

  const openModelEdit = (model: EnterpriseModelDto) => {
    setModelTarget(model)
    setModelModalOpen(true)
    modelForm.setFieldsValue({
      displayName: model.displayName,
      gatewayModelName: model.gatewayModelName,
      reservationTokens: model.reservationTokens,
    })
  }

  const submitModel = async () => {
    const values = await modelForm.validateFields()
    setSubmitting(true)
    try {
      if (modelTarget) {
        const body: UpdateModelRequest = {
          displayName: values.displayName,
          gatewayModelName: values.gatewayModelName,
          reservationTokens: values.reservationTokens ?? 0,
        }
        await llmApi.updateModel(modelTarget.id, body)
        message.success(`已更新模型 ${values.displayName}`)
      } else {
        const body: CreateModelRequest = {
          displayName: values.displayName,
          gatewayModelName: values.gatewayModelName,
          reservationTokens: values.reservationTokens ?? 0,
        }
        await llmApi.createModel(body)
        message.success(`已创建模型 ${values.displayName}`)
      }
      setModelModalOpen(false)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存模型失败')
      // 失败也刷新列表:请求可能服务端已成功但响应中断(如超时),让列表反映真实状态
      void load()
    } finally {
      setSubmitting(false)
    }
  }

  const toggleModel = async (model: EnterpriseModelDto) => {
    try {
      if (model.enabled) {
        await llmApi.disableModel(model.id)
        message.success(`已停用模型 ${model.displayName}`)
      } else {
        await llmApi.enableModel(model.id)
        message.success(`已启用模型 ${model.displayName}`)
      }
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  // 已有用量记录时后端返回 409(LLM_MODEL_IN_USE),错误消息直接透出提示改用停用
  const removeModel = async (model: EnterpriseModelDto) => {
    try {
      await llmApi.deleteModel(model.id)
      message.success(`已删除模型 ${model.displayName}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  // ---------- 网关模型名下拉(可搜索,数量多时虚拟滚动;底部展示数量与刷新入口) ----------

  const gatewayOptions = newapiModels.map(name => ({ value: name, label: name }))

  const refreshNewapiButton = (
    <Button
      type="link"
      size="small"
      icon={<SyncOutlined spin={newapiLoading} />}
      onMouseDown={e => e.preventDefault()}
      onClick={() => void loadNewapiModels()}
    >
      刷新
    </Button>
  )

  const gatewayNotFoundContent = newapiLoading ? (
    <Spin size="small" style={{ display: 'block', margin: '12px auto' }} />
  ) : newapiError ? (
    <div style={{ padding: '8px 12px', textAlign: 'center' }}>
      <Typography.Paragraph type="danger" style={{ fontSize: 12, marginBottom: 8 }}>
        {newapiError}
      </Typography.Paragraph>
      {refreshNewapiButton}
    </div>
  ) : (
    <div style={{ padding: '8px 12px', textAlign: 'center' }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        New API 未返回任何模型，请先在 New API 中配置渠道
      </Typography.Paragraph>
      {refreshNewapiButton}
    </div>
  )

  const gatewayDropdownRender = (menu: ReactNode) => (
    <>
      {menu}
      <Divider style={{ margin: '4px 0' }} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '2px 8px 6px',
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {newapiModels.length} 个模型
        </Typography.Text>
        {refreshNewapiButton}
      </div>
    </>
  )

  const modelColumns: ColumnsType<EnterpriseModelDto> = [
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    { title: '网关模型名', dataIndex: 'gatewayModelName', key: 'gatewayModelName' },
    {
      title: '额度预留',
      dataIndex: 'reservationTokens',
      key: 'reservationTokens',
      align: 'right',
      render: (v: number) => (v ?? 0).toLocaleString(),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_, model) => (
        <Space size="small">
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openModelEdit(model)}>
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => toggleModel(model)}>
            {model.enabled ? '停用' : '启用'}
          </Button>
          <Popconfirm
            title="删除模型"
            description={`将删除「${model.displayName}」并清理其额度授权与用户路由；已有用量记录的模型无法删除。`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void removeModel(model)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>模型接入</Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
      </Space>
      <Card
        title="企业模型"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openModelCreate}>
            新建模型
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          显示名是员工可见的模型名称；网关模型名从 New API 模型清单中选择（需先在 New API 渠道中配置该模型名），创建后不可修改。
        </Typography.Paragraph>
        <Table<EnterpriseModelDto>
          rowKey="id"
          columns={modelColumns}
          dataSource={models}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>
      <Modal
        title={modelTarget ? `编辑模型 ${modelTarget.displayName}` : '新建模型'}
        open={modelModalOpen}
        onCancel={() => setModelModalOpen(false)}
        onOk={submitModel}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={modelForm} layout="vertical">
          <Form.Item
            name="displayName"
            label="显示名"
            rules={[{ required: true, message: '请输入显示名' }, { max: 100, message: '显示名不超过 100 字' }]}
          >
            <Input placeholder="员工端展示的名称,如:GPT-4o 标准版" />
          </Form.Item>
          <Form.Item
            name="gatewayModelName"
            label="网关模型名"
            tooltip="取值来自 New API 模型清单（转发令牌可路由集合），创建后不可修改"
            rules={[{ required: true, message: '请选择网关模型名' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="从 New API 模型清单中选择"
              loading={newapiLoading}
              disabled={!!modelTarget}
              options={gatewayOptions}
              notFoundContent={gatewayNotFoundContent}
              dropdownRender={gatewayDropdownRender}
            />
          </Form.Item>
          <Form.Item
            name="reservationTokens"
            label="额度预留(token)"
            tooltip="流式请求的额度预留量"
          >
            <InputNumber style={{ width: '100%' }} min={0} precision={0} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
