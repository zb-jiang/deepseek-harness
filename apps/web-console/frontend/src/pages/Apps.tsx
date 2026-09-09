import { ApartmentOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { UploadFile, UploadProps } from 'antd/es/upload'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type ApplicationDto,
  appsApi,
  type CreateApplicationRequest,
} from '../api/apps'
import { usersApi, type UserDto } from '../api/users'
import { PLATFORM_ROLE } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const STATUS_COLOR: Record<string, string> = {
  active: 'green',
  suspended: 'orange',
  archived: 'red',
}

const STATUS_TEXT: Record<string, string> = {
  active: '活跃',
  suspended: '暂停',
  archived: '已归档',
}

const DEFAULT_APP_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM1NTUiIHN0cm9rZS13aWR0aD0iMiI+PHJlY3QgeD0iMyIgeT0iMyIgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iMiIvPjxjaXJjbGUgY3g9IjguNSIgY3k9IjguNSIgcj0iMS41Ii8+PHBhdGggZD0iTTIxIDE1bC01LTUtMTYgMTYiLz48L3N2Zz4='

function isAdminRole(roles: string[] | undefined): boolean {
  if (!roles) return false
  return roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN) || roles.includes(PLATFORM_ROLE.APP_ADMIN)
}

export default function AppsPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { me } = useAuth()
  const roles = me?.roles ?? []
  const isSystemAdmin = roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN)
  const isAppAdmin = roles.includes(PLATFORM_ROLE.APP_ADMIN)
  const canCreate = isSystemAdmin || isAppAdmin
  const [data, setData] = useState<ApplicationDto[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [users, setUsers] = useState<UserDto[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<CreateApplicationRequest>()
  const [iconFileList, setIconFileList] = useState<UploadFile[]>([])

  const loadUsers = useCallback(async () => {
    if (!isSystemAdmin) {
      setUsers([])
      return
    }
    try {
      const list = await usersApi.list({ status: 'active', limit: 200 })
      // 只保留 system_admin 或 app_admin 角色的用户
      const admins = (list ?? []).filter(u => isAdminRole(u.platformRoles))
      setUsers(admins)
    } catch (e) {
      // 静默失败
      // biome-ignore lint/suspicious/noConsole: 启动期诊断
      console.warn('[apps] load users failed', e)
    }
  }, [isSystemAdmin])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await appsApi.list({ status: statusFilter, limit: 200 })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载应用失败')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, message])

  useEffect(() => {
    void load()
    void loadUsers()
  }, [load, loadUsers])

  const handleArchive = async (app: ApplicationDto) => {
    try {
      await appsApi.archive(app.id)
      message.success(`已归档 ${app.name}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '归档失败')
    }
  }

  const handleIconChange: UploadProps['onChange'] = ({ fileList }) => {
    // 始终只保留最后一个文件,实现替换效果;不显示删除按钮,通过重新选择替换
    const latest = fileList.slice(-1)
    setIconFileList(latest)
    const file = latest[0]?.originFileObj
    if (file) {
      const reader = new FileReader()
      reader.onload = () => {
        createForm.setFieldValue('icon', reader.result as string)
      }
      reader.readAsDataURL(file)
    } else {
      createForm.setFieldValue('icon', undefined)
    }
  }

  const submitCreate = async () => {
    const values = await createForm.validateFields()
    try {
      const created = await appsApi.create(values)
      message.success(`已创建应用 ${created.name}`)
      setCreateOpen(false)
      createForm.resetFields()
      setIconFileList([])
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    }
  }

  const userOptions = useMemo(() => {
    const options = users.map(u => ({
      label: `${u.displayName || u.loginName} (${u.email})`,
      value: u.id,
    }))
    if (isAppAdmin && !isSystemAdmin && me?.platformUserId) {
      // app_admin 创建应用时也要能在下拉框中看到自己的展示名
      options.push({
        label: `${me.displayName || me.loginName || '我'} (${me.email})`,
        value: me.platformUserId,
      })
    }
    return options
  }, [users, isAppAdmin, isSystemAdmin, me])

  const columns: ColumnsType<ApplicationDto> = [
    {
      title: '应用名',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, app) => (
        <Space>
          <img
            src={app.icon || DEFAULT_APP_ICON}
            alt=""
            style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }}
          />
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/apps/${app.id}`)}>
            {v}
          </Button>
        </Space>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: v => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_, app) => (
        <Space size="small">
          <Button size="small" type="link" onClick={() => navigate(`/apps/${app.id}`)}>
            详情
          </Button>
          {app.status !== 'archived' && (
            <Button size="small" type="link" danger onClick={() => handleArchive(app)}>
              归档
            </Button>
          )}
        </Space>
      ),
    },
  ]

  const openCreateModal = () => {
    createForm.resetFields()
    setIconFileList([])
    if (isAppAdmin && !isSystemAdmin && me?.platformUserId) {
      // app_admin 创建应用时默认把自己设为管理员(后端也会强制加入)
      createForm.setFieldsValue({ appAdminUserIds: [me.platformUserId] })
    }
    setCreateOpen(true)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <ApartmentOutlined /> 应用管理
        </Typography.Title>
        <Select
          allowClear
          placeholder="按状态过滤"
          style={{ width: 160 }}
          value={statusFilter}
          onChange={v => setStatusFilter(v)}
          options={Object.entries(STATUS_TEXT).map(([k, v]) => ({ label: v, value: k }))}
        />
        <Button onClick={() => load()}>刷新</Button>
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            新建应用
          </Button>
        )}
      </Space>
      <Table<ApplicationDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
      <Modal
        title="新建应用"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        destroyOnClose
        width={520}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="name"
            label="应用名"
            rules={[{ required: true, message: '请输入应用名' }]}
          >
            <Input placeholder="应用名" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="应用描述(可空)" />
          </Form.Item>
          <Form.Item label="图标">
            <Space direction="vertical">
              <Upload
                accept="image/*"
                maxCount={1}
                listType="picture-card"
                showUploadList={{ showPreviewIcon: false, showRemoveIcon: false }}
                fileList={iconFileList}
                beforeUpload={() => false}
                onChange={handleIconChange}
              >
                <div style={{ color: '#999' }}>
                  <PlusOutlined />
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    {iconFileList.length === 0 ? '选择图片' : '替换图片'}
                  </div>
                </div>
              </Upload>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                未上传时系统自动使用默认图标
              </Typography.Text>
            </Space>
            <Form.Item name="icon" hidden>
              <Input />
            </Form.Item>
          </Form.Item>
          <Form.Item
            name="appAdminUserIds"
            label="应用管理员"
            rules={[{ required: true, message: '至少选择一个应用管理员' }]}
          >
            <Select
              mode="multiple"
              options={userOptions}
              placeholder="选择应用管理员(可多选)"
              showSearch
              optionFilterProp="label"
              disabled={isAppAdmin && !isSystemAdmin}
            />
          </Form.Item>
          {isAppAdmin && !isSystemAdmin && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              应用管理员创建应用时自动成为该应用管理员。
            </Typography.Paragraph>
          )}
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            应用创建后立即处于活跃状态,可直接创建流程定义与角色。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
