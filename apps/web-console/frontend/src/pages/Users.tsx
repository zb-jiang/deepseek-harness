import { CheckCircleOutlined, EditOutlined, LockOutlined, StopOutlined, TeamOutlined } from '@ant-design/icons'
import { App, Button, Form, Modal, Popconfirm, Select, Space, Table, Tag, TreeSelect, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { type OrgUnitTreeNode, orgUnitsApi } from '../api/org-units'
import { PLATFORM_ROLE } from '../api/types'
import { type UpdateUserRequest, usersApi, type UserDto } from '../api/users'

const STATUS_COLOR: Record<string, string> = {
  pending_approval: 'default',
  active: 'green',
  disabled: 'red',
  locked: 'orange',
}

const STATUS_TEXT: Record<string, string> = {
  pending_approval: '待审批',
  active: '正常',
  disabled: '已禁用',
  locked: '已锁定',
}

const ROLE_OPTIONS = [
  { label: '系统管理员', value: PLATFORM_ROLE.SYSTEM_ADMIN },
  { label: '应用管理员', value: PLATFORM_ROLE.APP_ADMIN },
  { label: '普通用户', value: 'normal_user' },
]

/** 部门树 → TreeSelect treeData(仅显示部门名,层级由树结构表达) */
function toTreeSelectData(nodes: OrgUnitTreeNode[]): { title: string; value: string; children: ReturnType<typeof toTreeSelectData> }[] {
  return (nodes ?? []).map(n => ({
    title: n.name,
    value: n.id,
    children: toTreeSelectData(n.children ?? []),
  }))
}

export default function UsersPage() {
  const { message } = App.useApp()
  const [data, setData] = useState<UserDto[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [editTarget, setEditTarget] = useState<UserDto | null>(null)
  const [editForm] = Form.useForm<UpdateUserRequest>()
  const [orgTree, setOrgTree] = useState<OrgUnitTreeNode[]>([])
  const [orgTarget, setOrgTarget] = useState<UserDto | null>(null)
  const [orgForm] = Form.useForm<{ orgUnitIds?: string[] }>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await usersApi.list({ status: statusFilter, limit: 200 })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载用户失败')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, message])

  useEffect(() => {
    // 部门树一次拉全量:分配弹窗下拉用
    orgUnitsApi.tree().then(t => setOrgTree(t ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleApprove = async (user: UserDto) => {
    try {
      await usersApi.approve(user.id)
      message.success(`已审批 ${user.loginName}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '审批失败')
    }
  }

  const handleDisable = async (user: UserDto) => {
    try {
      await usersApi.disable(user.id)
      message.success(`已禁用 ${user.loginName}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '禁用失败')
    }
  }

  const handleLock = async (user: UserDto) => {
    try {
      await usersApi.lock(user.id)
      message.success(`已锁定 ${user.loginName}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '锁定失败')
    }
  }

  const handleActivate = async (user: UserDto) => {
    try {
      await usersApi.activate(user.id)
      message.success(`已激活 ${user.loginName}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '激活失败')
    }
  }

  const NORMAL_USER_ROLE = 'normal_user'

  const ensureNormalUser = (roles: string[]): string[] => {
    if (!roles.includes(NORMAL_USER_ROLE)) {
      return [...roles, NORMAL_USER_ROLE]
    }
    return roles
  }

  const openEdit = (user: UserDto) => {
    setEditTarget(user)
    editForm.setFieldsValue({ platformRoles: ensureNormalUser(user.platformRoles ?? []) })
  }

  const openAssignOrg = (user: UserDto) => {
    setOrgTarget(user)
    orgForm.setFieldsValue({ orgUnitIds: (user.orgUnits ?? []).map(o => o.orgUnitId) })
  }

  const submitAssignOrg = async () => {
    if (!orgTarget) return
    const values = await orgForm.validateFields()
    try {
      await usersApi.assignOrgUnits(orgTarget.id, values.orgUnitIds ?? [])
      message.success(`已更新 ${orgTarget.loginName} 的所属部门`)
      setOrgTarget(null)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '分配部门失败')
    }
  }

  const submitEdit = async () => {
    if (!editTarget) return
    const values = await editForm.validateFields()
    const body = { platformRoles: ensureNormalUser(values.platformRoles ?? []) }
    try {
      await usersApi.updateRoles(editTarget.id, body)
      message.success(`已更新 ${editTarget.loginName} 的角色`)
      setEditTarget(null)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败')
    }
  }

  const columns: ColumnsType<UserDto> = [
    { title: '登录名', dataIndex: 'loginName', key: 'loginName' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName', render: v => v || '-' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '平台角色',
      dataIndex: 'platformRoles',
      key: 'platformRoles',
      render: (roles: string[]) =>
        (roles ?? []).length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <Space wrap>
            {roles.map((r) => {
              const roleLabel = r === PLATFORM_ROLE.SYSTEM_ADMIN
                ? '系统管理员'
                : r === PLATFORM_ROLE.APP_ADMIN
                  ? '应用管理员'
                  : '普通用户'
              const color = r === PLATFORM_ROLE.SYSTEM_ADMIN ? 'purple' : r === PLATFORM_ROLE.APP_ADMIN ? 'blue' : 'default'
              return (
                <Tag key={r} color={color}>
                  {roleLabel}
                </Tag>
              )
            })}
          </Space>
        ),
    },
    {
      title: '所属部门',
      dataIndex: 'orgUnits',
      key: 'orgUnits',
      render: (orgUnits: UserDto['orgUnits']) =>
        (orgUnits ?? []).length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <Space wrap size={4}>
            {orgUnits.map(o => (
              <Tag key={o.orgUnitId} color="cyan">{o.name}</Tag>
            ))}
          </Space>
        ),
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
      width: 280,
      render: (_, user) => (
        <Space size="small" wrap>
          {user.status === 'pending_approval' && (
            <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => handleApprove(user)}>
              审批
            </Button>
          )}
          {user.status === 'active' && (
            <>
              <Button size="small" type="link" icon={<StopOutlined />} onClick={() => handleDisable(user)}>
                禁用
              </Button>
              <Button size="small" type="link" icon={<LockOutlined />} onClick={() => handleLock(user)}>
                锁定
              </Button>
            </>
          )}
          {(user.status === 'disabled' || user.status === 'locked') && (
            <Popconfirm title={`激活 ${user.loginName}?`} onConfirm={() => handleActivate(user)}>
              <Button size="small" type="link">激活</Button>
            </Popconfirm>
          )}
          {user.status !== 'pending_approval' && (
            <>
              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(user)}>
                编辑角色
              </Button>
              <Button size="small" type="link" icon={<TeamOutlined />} onClick={() => openAssignOrg(user)}>
                分配部门
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>用户管理</Typography.Title>
        <Select
          allowClear
          placeholder="按状态过滤"
          style={{ width: 160 }}
          value={statusFilter}
          onChange={v => setStatusFilter(v)}
          options={Object.entries(STATUS_TEXT).map(([k, v]) => ({ label: v, value: k }))}
        />
        <Button onClick={() => load()}>刷新</Button>
      </Space>
      <Table<UserDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />
      <Modal
        title={editTarget ? `编辑 ${editTarget.loginName} 的角色` : '编辑角色'}
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={submitEdit}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="platformRoles"
            label="平台角色"
            rules={[{ required: true, message: '至少选择一个角色' }]}
          >
            <Select
              mode="multiple"
              options={ROLE_OPTIONS}
              placeholder="选择平台角色"
              tagRender={(props) => {
                const { label, value, closable, onClose } = props
                const isNormal = value === NORMAL_USER_ROLE
                return (
                  <Tag
                    color={value === PLATFORM_ROLE.SYSTEM_ADMIN ? 'purple' : value === PLATFORM_ROLE.APP_ADMIN ? 'blue' : 'default'}
                    closable={!isNormal && closable}
                    onClose={isNormal ? undefined : onClose}
                    style={{ marginRight: 4 }}
                  >
                    {label}
                  </Tag>
                )
              }}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            系统管理员可访问所有应用;应用管理员只能访问自己所属应用。
          </Typography.Paragraph>
        </Form>
      </Modal>
      <Modal
        title={orgTarget ? `分配 ${orgTarget.loginName} 的所属部门` : '分配所属部门'}
        open={!!orgTarget}
        onCancel={() => setOrgTarget(null)}
        onOk={submitAssignOrg}
        destroyOnClose
      >
        <Form form={orgForm} layout="vertical">
          <Form.Item
            name="orgUnitIds"
            label="所属部门(可多选)"
            tooltip="员工可归属多个部门;发起流程时选择以哪个身份发起,同行政线审批路由按该身份解析"
          >
            <TreeSelect
              multiple
              allowClear
              showSearch
              treeNodeFilterProp="title"
              placeholder="选择部门(可多选,可清空)"
              treeData={toTreeSelectData(orgTree)}
              maxTagCount="responsive"
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            提交即全量覆盖;部门的负责人不能被移出该部门,需先更换负责人。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
