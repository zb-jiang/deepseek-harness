import { EditOutlined, PlusOutlined } from '@ant-design/icons'
import {
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile, UploadProps } from 'antd/es/upload'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  type ApplicationDto,
  appsApi,
  type SkillHubSkillDto,
  type UpdateApplicationRequest,
} from '../api/apps'
import {
  type AppMembershipDto,
  membershipsApi,
  type UpsertMembershipRequest,
} from '../api/memberships'
import {
  type AppRoleDto,
  rolesApi,
  type CreateAppRoleRequest,
  type UpdateAppRoleRequest,
} from '../api/roles'
import { usersApi, type UserDto } from '../api/users'

const ROLE_STATUS_COLOR: Record<string, string> = {
  active: 'green',
  disabled: 'default',
}

const MEMBERSHIP_STATUS_COLOR: Record<string, string> = {
  active: 'green',
  disabled: 'default',
}

function shortId(id: string | null): string {
  if (!id) return '-'
  return id.slice(0, 8)
}

export default function AppDetailPage() {
  const { appId = '' } = useParams()
  const { message } = App.useApp()
  const navigate = useNavigate()

  const [app, setApp] = useState<ApplicationDto | null>(null)
  const [users, setUsers] = useState<UserDto[]>([])
  const [, setLoading] = useState(false)
  const [editAppOpen, setEditAppOpen] = useState(false)
  const [editAppForm] = Form.useForm<UpdateApplicationRequest>()
  const [iconFileList, setIconFileList] = useState<UploadFile[]>([])

  const userMap = useMemo(() => {
    const m = new Map<string, UserDto>()
    for (const u of users) m.set(u.id, u)
    return m
  }, [users])

  const loadApp = useCallback(async () => {
    if (!appId) return
    setLoading(true)
    try {
      const [appData, userList] = await Promise.all([
        appsApi.get(appId),
        usersApi.list({ status: 'active', limit: 500 }).catch(() => []),
      ])
      setApp(appData)
      setUsers(userList ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载应用失败')
    } finally {
      setLoading(false)
    }
  }, [appId, message])

  useEffect(() => {
    void loadApp()
  }, [loadApp])

  const submitEditApp = async () => {
    if (!app) return
    const values = await editAppForm.validateFields()
    try {
      const updated = await appsApi.update(app.id, {
        name: values.name,
        description: values.description,
        icon: values.icon,
      })
      message.success(`已更新 ${updated.name}`)
      setEditAppOpen(false)
      setIconFileList([])
      setApp(updated)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败')
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
        editAppForm.setFieldValue('icon', reader.result as string)
      }
      reader.readAsDataURL(file)
    } else {
      editAppForm.setFieldValue('icon', undefined)
    }
  }

  const handleArchive = async () => {
    if (!app) return
    try {
      const updated = await appsApi.archive(app.id)
      message.success(`已归档 ${updated.name}`)
      setApp(updated)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '归档失败')
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => navigate('/apps')}>返回应用列表</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {app?.name ?? '应用详情'}
        </Typography.Title>
        {app && (
          <>
            <Button icon={<EditOutlined />} onClick={() => {
              editAppForm.setFieldsValue({
                name: app.name,
                description: app.description ?? undefined,
                icon: app.icon ?? undefined,
              })
              setIconFileList(app.icon
                ? [{
                  uid: '-1',
                  name: 'icon',
                  status: 'done',
                  url: app.icon,
                  thumbUrl: app.icon,
                }]
                : [])
              setEditAppOpen(true)
            }}>编辑</Button>
            {app.status !== 'archived' && (
              <Button danger onClick={handleArchive}>归档</Button>
            )}
          </>
        )}
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: 'ID', children: app?.id ?? '-' },
          { key: 'name', label: '名称', children: app?.name ?? '-' },
          { key: 'description', label: '描述', children: app?.description ?? '-' },
          { key: 'status', label: '状态', children: app ? <Tag color={app.status === 'active' ? 'green' : 'default'}>{app.status}</Tag> : '-' },
          { key: 'createdAt', label: '创建时间', children: app?.createdAt ? dayjs(app.createdAt).format('YYYY-MM-DD HH:mm') : '-' },
          {
            key: 'admins',
            label: '管理员',
            children: (app?.appAdminUserIds ?? []).map((id) => {
              const u = userMap.get(id)
              return <Tag key={id}>{u ? u.displayName || u.loginName : shortId(id)}</Tag>
            }),
          },
          { key: 'skillhub', label: 'Skill 仓库', children: app?.skillhubNamespace || '-' },
        ]}
      />

      <Tabs
        defaultActiveKey="roles"
        items={[
          {
            key: 'roles',
            label: '角色',
            children: <RolesTab appId={appId} />,
          },
          {
            key: 'memberships',
            label: '成员',
            children: <MembershipsTab appId={appId} />,
          },
          {
            key: 'skillhub',
            label: 'Skill 仓库',
            children: app ? (
              <SkillRepoTab app={app} onAppUpdated={() => { void loadApp() }} />
            ) : null,
          },
          {
            key: 'workflows',
            label: '流程定义',
            children: (
              <Button type="primary" onClick={() => navigate(`/workflows?appId=${appId}`)}>
                打开流程定义列表
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title="编辑应用"
        open={editAppOpen}
        onCancel={() => setEditAppOpen(false)}
        onOk={submitEditApp}
        destroyOnClose
      >
        <Form form={editAppForm} layout="vertical">
          <Form.Item name="name" label="应用名" rules={[{ required: true, message: '请输入应用名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="图标">
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
            <Form.Item name="icon" hidden>
              <Input />
            </Form.Item>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            点击图片即可重新上传替换;不允许删除图标。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}

// ===== 角色 tab =====
function RolesTab({ appId }: { appId: string }) {
  const { message } = App.useApp()
  const [data, setData] = useState<AppRoleDto[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<CreateAppRoleRequest>()
  const [editTarget, setEditTarget] = useState<AppRoleDto | null>(null)
  const [editForm] = Form.useForm<UpdateAppRoleRequest>()

  const load = useCallback(async () => {
    if (!appId) return
    setLoading(true)
    try {
      setData((await rolesApi.listByApp(appId)) ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载角色失败')
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
      await rolesApi.create(appId, {
        name: values.name,
        description: values.description,
        parentRoleId: values.parentRoleId || null,
      })
      message.success(`已创建角色 ${values.name}`)
      setCreateOpen(false)
      createForm.resetFields()
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    }
  }

  const submitEdit = async () => {
    if (!editTarget) return
    const values = await editForm.validateFields()
    try {
      await rolesApi.update(appId, editTarget.id, {
        name: values.name,
        description: values.description,
        parentRoleId: values.parentRoleId || null,
      })
      message.success(`已更新 ${values.name}`)
      setEditTarget(null)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败')
    }
  }

  // 父角色候选:编辑时排除自己及全部后代(选后代做父角色会成环);新建时全部可选
  const parentRoleOptions = useMemo(() => {
    if (!editTarget) {
      return data.map(r => ({ label: r.name, value: r.id }))
    }
    const excluded = new Set<string>([editTarget.id])
    let changed = true
    while (changed) {
      changed = false
      for (const r of data) {
        if (r.parentRoleId && excluded.has(r.parentRoleId) && !excluded.has(r.id)) {
          excluded.add(r.id)
          changed = true
        }
      }
    }
    return data.filter(r => !excluded.has(r.id)).map(r => ({ label: r.name, value: r.id }))
  }, [data, editTarget])

  const handleDisable = async (role: AppRoleDto) => {
    try {
      await rolesApi.disable(appId, role.id)
      message.success(`已停用 ${role.name}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '停用失败')
    }
  }

  const handleActivate = async (role: AppRoleDto) => {
    try {
      await rolesApi.activate(appId, role.id)
      message.success(`已激活 ${role.name}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '激活失败')
    }
  }

  const columns: ColumnsType<AppRoleDto> = [
    { title: '角色名', dataIndex: 'name', key: 'name' },
    {
      title: '角色 ID',
      dataIndex: 'id',
      key: 'id',
      width: 160,
      render: (_, role) => (
        <Typography.Text
          copyable={{ text: role.id, tooltips: ['复制角色 ID', '已复制'] }}
          style={{ fontFamily: 'monospace' }}
        >
          {shortId(role.id)}
        </Typography.Text>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: v => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: v => <Tag color={ROLE_STATUS_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '父角色',
      dataIndex: 'parentRoleId',
      key: 'parentRoleId',
      render: (v) => {
        if (!v) return '-'
        const parent = data.find(r => r.id === v)
        return parent ? parent.name : shortId(v)
      },
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
      width: 200,
      render: (_, role) => (
        <Space size="small">
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            onClick={() => {
              editForm.setFieldsValue({
                name: role.name,
                description: role.description ?? undefined,
                parentRoleId: role.parentRoleId ?? undefined,
              })
              setEditTarget(role)
            }}
          >
            编辑
          </Button>
          {role.status === 'active' && (
            <Button size="small" type="link" danger onClick={() => handleDisable(role)}>停用</Button>
          )}
          {role.status === 'disabled' && (
            <Button size="small" type="link" onClick={() => handleActivate(role)}>激活</Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建角色</Button>
        <Button onClick={() => load()}>刷新</Button>
      </Space>
      <Table<AppRoleDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
      <Modal
        title="新建角色"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请输入角色名' }]}>
            <Input placeholder="应用内唯一" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="parentRoleId" label="父角色">
            <Select
              allowClear
              options={parentRoleOptions}
              placeholder="选择父角色(可选)"
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            父角色可选且必须属于同一应用;上级角色继承下级角色权限。
          </Typography.Paragraph>
        </Form>
      </Modal>
      <Modal
        title={editTarget ? `编辑 ${editTarget.name}` : '编辑角色'}
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={submitEdit}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请输入角色名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="parentRoleId" label="父角色">
            <Select
              allowClear
              options={parentRoleOptions}
              placeholder="选择父角色(可选)"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ===== 成员 tab =====
function MembershipsTab({ appId }: { appId: string }) {
  const { message } = App.useApp()
  const [data, setData] = useState<AppMembershipDto[]>([])
  const [roles, setRoles] = useState<AppRoleDto[]>([])
  const [users, setUsers] = useState<UserDto[]>([])
  const [loading, setLoading] = useState(false)
  const [upsertOpen, setUpsertOpen] = useState(false)
  const [upsertForm] = Form.useForm<UpsertMembershipRequest>()
  const [editTarget, setEditTarget] = useState<AppMembershipDto | null>(null)
  const [editForm] = Form.useForm<UpsertMembershipRequest>()

  const userMap = useMemo(() => {
    const m = new Map<string, UserDto>()
    for (const u of users) m.set(u.id, u)
    return m
  }, [users])

  const roleMap = useMemo(() => {
    const m = new Map<string, AppRoleDto>()
    for (const r of roles) m.set(r.id, r)
    return m
  }, [roles])

  const load = useCallback(async () => {
    if (!appId) return
    setLoading(true)
    try {
      const [memList, roleList] = await Promise.all([
        membershipsApi.listByApp(appId),
        rolesApi.listByApp(appId),
      ])
      setData(memList ?? [])
      setRoles(roleList ?? [])
      // 拉用户列表(system_admin 能拉,app_admin 会失败,降级用 userId 显示)
      try {
        const list = await usersApi.list({ status: 'active', limit: 500 })
        setUsers(list ?? [])
      } catch {
        setUsers([])
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载成员失败')
    } finally {
      setLoading(false)
    }
  }, [appId, message])

  useEffect(() => {
    void load()
  }, [load])

  const submitUpsert = async () => {
    const values = await upsertForm.validateFields()
    try {
      await membershipsApi.upsert(appId, values)
      message.success('已保存成员')
      setUpsertOpen(false)
      upsertForm.resetFields()
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const submitEdit = async () => {
    if (!editTarget) return
    const values = await editForm.validateFields()
    try {
      await membershipsApi.upsert(appId, { userId: editTarget.userId, roleIds: values.roleIds })
      message.success('已更新成员角色')
      setEditTarget(null)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败')
    }
  }

  const handleDisable = async (m: AppMembershipDto) => {
    try {
      await membershipsApi.disable(appId, m.id)
      message.success('已停用成员')
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '停用失败')
    }
  }

  const handleActivate = async (m: AppMembershipDto) => {
    try {
      await membershipsApi.activate(appId, m.id)
      message.success('已激活成员')
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '激活失败')
    }
  }

  const userOptions = users.map(u => ({
    label: `${u.displayName || u.loginName} (${u.email})`,
    value: u.id,
  }))

  const roleOptions = roles.map(r => ({ label: r.name, value: r.id }))

  const columns: ColumnsType<AppMembershipDto> = [
    {
      title: '用户',
      dataIndex: 'userId',
      key: 'userId',
      render: (userId: string) => {
        const u = userMap.get(userId)
        return u ? `${u.displayName || u.loginName} (${u.email})` : <Typography.Text type="secondary">{shortId(userId)}(无权查看)</Typography.Text>
      },
    },
    {
      title: '角色',
      dataIndex: 'roleIds',
      key: 'roleIds',
      render: (roleIds: string[]) => (
        <Space wrap>
          {(roleIds ?? []).map((id) => {
            const r = roleMap.get(id)
            return <Tag key={id} color="blue">{r ? r.name : shortId(id)}</Tag>
          })}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: v => <Tag color={MEMBERSHIP_STATUS_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '授权时间',
      dataIndex: 'grantedAt',
      key: 'grantedAt',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, m) => (
        <Space size="small">
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            onClick={() => {
              editForm.setFieldsValue({ userId: m.userId, roleIds: m.roleIds })
              setEditTarget(m)
            }}
          >
            编辑
          </Button>
          {m.status === 'active' && (
            <Button size="small" type="link" danger onClick={() => handleDisable(m)}>停用</Button>
          )}
          {m.status === 'disabled' && (
            <Button size="small" type="link" onClick={() => handleActivate(m)}>激活</Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setUpsertOpen(true)}
          disabled={userOptions.length === 0}
        >
          添加成员
        </Button>
        <Button onClick={() => load()}>刷新</Button>
        {userOptions.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            (无权拉取用户列表,无法添加新成员;联系系统管理员)
          </Typography.Text>
        )}
      </Space>
      <Table<AppMembershipDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
      <Modal
        title="添加成员"
        open={upsertOpen}
        onCancel={() => setUpsertOpen(false)}
        onOk={submitUpsert}
        destroyOnClose
      >
        <Form form={upsertForm} layout="vertical">
          <Form.Item name="userId" label="用户" rules={[{ required: true, message: '请选择用户' }]}>
            <Select options={userOptions} placeholder="选择用户" showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="roleIds" label="角色" rules={[{ required: true, message: '至少选择一个角色' }]}>
            <Select mode="multiple" options={roleOptions} placeholder="选择角色" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="编辑成员角色"
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={submitEdit}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="userId" label="用户">
            <Select options={userOptions} disabled />
          </Form.Item>
          <Form.Item name="roleIds" label="角色" rules={[{ required: true, message: '至少选择一个角色' }]}>
            <Select mode="multiple" options={roleOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ===== Skill 仓库 tab =====
function SkillRepoTab({ app, onAppUpdated }: { app: ApplicationDto; onAppUpdated: () => void }) {
  const { message } = App.useApp()
  const [nsInput, setNsInput] = useState('')
  const [skills, setSkills] = useState<SkillHubSkillDto[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // 外层 loadApp 刷新 app 后,把输入框同步为当前绑定值
  useEffect(() => {
    setNsInput(app.skillhubNamespace ?? '')
  }, [app.skillhubNamespace])

  const loadSkills = useCallback(async () => {
    if (!app.skillhubNamespace) {
      setSkills([])
      return
    }
    setLoading(true)
    try {
      const list = await appsApi.listSkills(app.id)
      setSkills(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载 Skill 清单失败')
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [app.id, app.skillhubNamespace, message])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  // name 必传(后端 @NotBlank);description/icon/appAdminUserIds 不传即保持不变;
  // 空输入传空串 = 清除绑定
  const submitBinding = async () => {
    const ns = nsInput.trim()
    setSaving(true)
    try {
      await appsApi.update(app.id, { name: app.name, skillhubNamespace: ns })
      message.success(ns ? `已绑定 Skill 仓库 ${ns}` : '已清除 Skill 仓库绑定')
      onAppUpdated()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存绑定失败')
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<SkillHubSkillDto> = [
    { title: 'Skill 名', dataIndex: 'slug', key: 'slug' },
    { title: '当前版本', dataIndex: 'version', key: 'version' },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '指纹',
      dataIndex: 'fingerprint',
      key: 'fingerprint',
      render: (v: string) => (
        <Typography.Text style={{ fontFamily: 'monospace' }} title={v}>
          {v.slice(0, 8)}
        </Typography.Text>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Text type="secondary">当前绑定:</Typography.Text>
        {app.skillhubNamespace
          ? <Tag color="blue">{app.skillhubNamespace}</Tag>
          : <Typography.Text type="warning">未绑定</Typography.Text>}
        <Input
          style={{ width: 260 }}
          placeholder="如 finance / dsh-demo"
          maxLength={64}
          value={nsInput}
          onChange={e => setNsInput(e.target.value)}
        />
        <Button type="primary" loading={saving} onClick={submitBinding}>保存绑定</Button>
        {app.skillhubNamespace && <Button onClick={() => { void loadSkills() }}>刷新</Button>}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        绑定后,本应用流程的 user task 只能引用该 SkillHub 命名空间下已发布的 skill;清空输入保存即解除绑定。
      </Typography.Paragraph>
      {app.skillhubNamespace ? (
        <Table<SkillHubSkillDto>
          rowKey="slug"
          columns={columns}
          dataSource={skills}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      ) : (
        <Typography.Paragraph type="secondary">
          应用尚未绑定 SkillHub namespace;请先在上方输入命名空间并保存绑定。
        </Typography.Paragraph>
      )}
    </div>
  )
}
