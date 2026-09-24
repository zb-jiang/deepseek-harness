import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons'
import { App, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, TreeSelect, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'
import { type OrgUnitMemberDto, type OrgUnitTreeNode, orgUnitsApi, type SaveOrgUnitRequest } from '../api/org-units'
import { usersApi, type UserDto } from '../api/users'

/** 表单值(新增/编辑共用) */
interface OrgUnitFormValues {
  name: string
  parentId?: string | null
  headUserId?: string | null
  sortOrder?: number | null
}

/** 编辑目标:null=新增;含 parentId 预填的上下文 */
interface EditState {
  orgUnitId: string | null
  values: OrgUnitFormValues
}

/** TreeSelect treeData 节点 */
interface OrgTreeOption {
  value: string
  title: string
  children: OrgTreeOption[]
}

function shortId(id: string | null): string {
  if (!id) return '-'
  return id.slice(0, 8)
}

/** 成员面板用户状态显示(映射表里可能存在已停用/待开通用户) */
const MEMBER_STATUS: Record<string, { text: string; color: string }> = {
  active: { text: '正常', color: 'green' },
  disabled: { text: '已停用', color: 'orange' },
  pending_approval: { text: '待开通', color: 'blue' },
}

export default function OrgUnitsPage() {
  const { message } = App.useApp()
  const { me } = useAuth()
  // 编辑仅 system_admin(后端写接口同样只放 SYSTEM_ADMIN);其他角色只读
  const isSys = (me?.roles ?? []).includes(PLATFORM_ROLE.SYSTEM_ADMIN)
  // 负责人下拉数据:usersApi.list 需 SYSTEM_ADMIN/APP_ADMIN,normal_user 跳过
  const canListUsers = isSys || (me?.roles ?? []).includes(PLATFORM_ROLE.APP_ADMIN)
  const [tree, setTree] = useState<OrgUnitTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState<UserDto[]>([])
  const [edit, setEdit] = useState<EditState | null>(null)
  const [form] = Form.useForm<OrgUnitFormValues>()
  // 成员面板(部门维度维护 org_unit_members)
  const [memberUnit, setMemberUnit] = useState<OrgUnitTreeNode | null>(null)
  const [members, setMembers] = useState<OrgUnitMemberDto[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [addUserIds, setAddUserIds] = useState<string[]>([])
  const [membersSaving, setMembersSaving] = useState(false)

  const loadMembers = useCallback(async (unit: OrgUnitTreeNode) => {
    setMembersLoading(true)
    try {
      setMembers((await orgUnitsApi.members(unit.id)) ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载成员失败')
    } finally {
      setMembersLoading(false)
    }
  }, [message])

  const openMembers = (node: OrgUnitTreeNode) => {
    setMemberUnit(node)
    setAddUserIds([])
    void loadMembers(node)
  }

  const submitAddMembers = async () => {
    if (!memberUnit || addUserIds.length === 0) return
    setMembersSaving(true)
    try {
      setMembers((await orgUnitsApi.addMembers(memberUnit.id, addUserIds)) ?? [])
      message.success(`已加入 ${addUserIds.length} 名成员`)
      setAddUserIds([])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加入成员失败')
    } finally {
      setMembersSaving(false)
    }
  }

  const submitRemoveMember = async (userId: string) => {
    if (!memberUnit) return
    try {
      setMembers((await orgUnitsApi.removeMember(memberUnit.id, userId)) ?? [])
      message.success('已移出成员')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '移出成员失败')
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [unitTree, activeUsers] = await Promise.all([
        orgUnitsApi.tree(),
        canListUsers ? usersApi.list({ status: 'active', limit: 200 }) : Promise.resolve([] as UserDto[]),
      ])
      setTree(unitTree ?? [])
      setUsers(activeUsers ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载部门失败')
    } finally {
      setLoading(false)
    }
  }, [message, canListUsers])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = (parentId: string | null) => {
    setEdit({ orgUnitId: null, values: { name: '', parentId, headUserId: null, sortOrder: 0 } })
    form.setFieldsValue({ name: '', parentId, headUserId: null, sortOrder: 0 })
  }

  const openEdit = (node: OrgUnitTreeNode) => {
    setEdit({
      orgUnitId: node.id,
      values: {
        name: node.name,
        parentId: node.parentId,
        headUserId: node.headUserId,
        sortOrder: node.sortOrder,
      },
    })
    form.setFieldsValue({
      name: node.name,
      parentId: node.parentId,
      headUserId: node.headUserId,
      sortOrder: node.sortOrder,
    })
  }

  const submit = async () => {
    if (!edit) return
    const values = await form.validateFields()
    const body: SaveOrgUnitRequest = {
      name: values.name,
      parentId: values.parentId ?? null,
      headUserId: values.headUserId ?? null,
      sortOrder: values.sortOrder ?? 0,
    }
    try {
      if (edit.orgUnitId) {
        await orgUnitsApi.update(edit.orgUnitId, body)
        message.success(`已更新部门 ${values.name}`)
      } else {
        await orgUnitsApi.create(body)
        message.success(`已创建部门 ${values.name}`)
      }
      setEdit(null)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const handleDelete = async (node: OrgUnitTreeNode) => {
    try {
      await orgUnitsApi.remove(node.id)
      message.success(`已删除部门 ${node.name}`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const columns: ColumnsType<OrgUnitTreeNode> = [
    { title: '部门', dataIndex: 'name', key: 'name' },
    {
      title: '部门 ID',
      dataIndex: 'id',
      key: 'id',
      width: 160,
      render: (_, node) => (
        <Typography.Text
          copyable={{ text: node.id, tooltips: ['复制部门 ID', '已复制'] }}
          style={{ fontFamily: 'monospace' }}
        >
          {shortId(node.id)}
        </Typography.Text>
      ),
    },
    {
      title: '负责人',
      dataIndex: 'headUserName',
      key: 'headUserName',
      render: (v: string | null) =>
        v ?? <Typography.Text type="secondary">未配置</Typography.Text>,
    },
    { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 80 },
    // 操作列对所有角色显示:成员按钮全员可看(只读),管理按钮仅 system_admin
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_: unknown, node: OrgUnitTreeNode) => (
        <Space size="small">
          <Button size="small" type="link" icon={<TeamOutlined />} onClick={() => openMembers(node)}>
            成员
          </Button>
          {isSys && (
            <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openCreate(node.id)}>
              新增子部门
            </Button>
          )}
          {isSys && (
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(node)}>
              编辑
            </Button>
          )}
          {isSys && (
            <Popconfirm
              title={`删除部门「${node.name}」?`}
              description="仅可删除无子部门且无成员的部门"
              onConfirm={() => handleDelete(node)}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  /** 父部门 TreeSelect 数据(编辑时排除自己,其子树随之排除,防循环引用) */
  const toTreeData = (nodes: OrgUnitTreeNode[], excludeId?: string | null): OrgTreeOption[] =>
    nodes
      .filter(n => n.id !== excludeId)
      .map(n => ({ value: n.id, title: n.name, children: toTreeData(n.children ?? [], excludeId) }))

  const userOptions = users.map(u => ({
    label: `${u.displayName || u.loginName}(${u.loginName})`,
    value: u.id,
  }))

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>部门管理</Typography.Title>
        {isSys && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(null)}>
            新增根部门
          </Button>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        组织树是全局共享的行政线:审批路由按「范围 × 角色」在部门上解析审批人,每个部门可配置负责人(虚拟角色"上一级"取此)。
        {!isSys && ' 当前账号为只读视图,仅系统管理员可编辑。'}
      </Typography.Paragraph>
      <Table<OrgUnitTreeNode>
        rowKey="id"
        columns={columns}
        dataSource={tree}
        loading={loading}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
      />
      <Modal
        title={edit?.orgUnitId ? `编辑部门 ${edit.values.name}` : '新增部门'}
        open={!!edit}
        onCancel={() => setEdit(null)}
        onOk={submit}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="部门名称"
            rules={[
              { required: true, message: '请输入部门名称' },
              { max: 100, message: '名称不超过 100 字' },
            ]}
          >
            <Input placeholder="如:华东区" />
          </Form.Item>
          <Form.Item name="parentId" label="父部门(清空=根部门)">
            <TreeSelect
              allowClear
              treeDefaultExpandAll
              treeData={toTreeData(tree, edit?.orgUnitId ?? null)}
              placeholder="不选则为根部门"
              fieldNames={{ label: 'title', value: 'value', children: 'children' }}
            />
          </Form.Item>
          <Form.Item name="headUserId" label="部门负责人">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={userOptions}
              placeholder="选择负责人(虚拟角色上一级/下一级按此解析)"
            />
          </Form.Item>
          <Form.Item name="sortOrder" label="同级排序(小的在前)">
            <InputNumber style={{ width: '100%' }} min={0} precision={0} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={memberUnit ? `部门成员 - ${memberUnit.name}(${members.length} 人)` : '部门成员'}
        width={560}
        open={!!memberUnit}
        onClose={() => setMemberUnit(null)}
        destroyOnClose
      >
        {isSys && (
          <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              style={{ flex: 1 }}
              placeholder="选择要加入本部门的用户(支持搜索)"
              value={addUserIds}
              onChange={setAddUserIds}
              options={users
                .filter(u => !members.some(m => m.userId === u.id))
                .map(u => ({ label: `${u.displayName || u.loginName}(${u.loginName})`, value: u.id }))}
              notFoundContent="没有可选用户(全员均已是本部门成员或用户清单未加载)"
            />
            <Button
              type="primary"
              disabled={addUserIds.length === 0}
              loading={membersSaving}
              onClick={submitAddMembers}
            >
              添加
            </Button>
          </Space.Compact>
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {isSys
            ? '成员归属决定审批路由的成员判定(sameLine/fixedUnit 范围解析)与发起身份;负责人行不可移出,先在部门编辑里更换负责人。'
            : '只读视图:成员归属决定审批路由的成员判定与发起身份,调整请联系系统管理员。'}
        </Typography.Paragraph>
        <Table<OrgUnitMemberDto>
          rowKey="userId"
          size="small"
          loading={membersLoading}
          dataSource={members}
          pagination={false}
          columns={[
            {
              title: '成员',
              key: 'member',
              render: (_, m) => (
                <Space size="small">
                  <span>{m.displayName || m.loginName}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {m.loginName}
                  </Typography.Text>
                  {memberUnit && m.userId === memberUnit.headUserId && (
                    <Tag color="gold">负责人</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              width: 90,
              render: (s: string) => {
                const meta = MEMBER_STATUS[s]
                return meta ? <Tag color={meta.color}>{meta.text}</Tag> : <Tag>{s}</Tag>
              },
            },
            // 移出操作仅 system_admin;其他角色只读
            ...(isSys
              ? [{
                title: '操作',
                key: 'action',
                width: 80,
                render: (_: unknown, m: OrgUnitMemberDto) => {
                  const isHead = memberUnit != null && m.userId === memberUnit.headUserId
                  return (
                    <Popconfirm
                      title={`将「${m.displayName || m.loginName}」移出本部门?`}
                      onConfirm={() => submitRemoveMember(m.userId)}
                      disabled={isHead}
                    >
                      <Button
                        size="small"
                        type="link"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={isHead}
                      >
                        移出
                      </Button>
                    </Popconfirm>
                  )
                },
              } satisfies ColumnsType<OrgUnitMemberDto>[number]]
              : []),
          ]}
        />
      </Drawer>
    </div>
  )
}
