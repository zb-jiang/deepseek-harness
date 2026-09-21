import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, TreeSelect, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'
import { type OrgUnitTreeNode, orgUnitsApi, type SaveOrgUnitRequest } from '../api/org-units'
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

export default function OrgUnitsPage() {
  const { message } = App.useApp()
  const [tree, setTree] = useState<OrgUnitTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState<UserDto[]>([])
  const [edit, setEdit] = useState<EditState | null>(null)
  const [form] = Form.useForm<OrgUnitFormValues>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [unitTree, activeUsers] = await Promise.all([
        orgUnitsApi.tree(),
        usersApi.list({ status: 'active', limit: 200 }),
      ])
      setTree(unitTree ?? [])
      setUsers(activeUsers ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载部门失败')
    } finally {
      setLoading(false)
    }
  }, [message])

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
      title: '负责人',
      dataIndex: 'headUserName',
      key: 'headUserName',
      render: (v: string | null) =>
        v ?? <Typography.Text type="secondary">未配置</Typography.Text>,
    },
    { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 80 },
    {
      title: '操作',
      key: 'action',
      width: 240,
      render: (_, node) => (
        <Space size="small">
          <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openCreate(node.id)}>
            新增子部门
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(node)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除部门「${node.name}」?`}
            description="仅可删除无子部门且无成员的部门"
            onConfirm={() => handleDelete(node)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
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
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(null)}>
          新增根部门
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        组织树是全局共享的行政线:审批路由按「范围 × 角色」在部门上解析审批人,每个部门可配置负责人(虚拟角色"上一级"取此)。
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
    </div>
  )
}
