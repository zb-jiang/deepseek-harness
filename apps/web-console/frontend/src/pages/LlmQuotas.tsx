import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Drawer, Empty, Form, InputNumber, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import {
  type CreateGrantRequest,
  type CreateRouteRequest,
  type EnterpriseModelDto,
  llmApi,
  type QuotaGrantDto,
  type RouteItemParam,
  type UpdateGrantRequest,
  type UpdateRouteRequest,
  type UsageSummaryRow,
  type UserModelRouteDto,
} from '../api/llm'
import { type OrgUnitTreeNode, orgUnitsApi } from '../api/org-units'
import { usersApi, type UserDto } from '../api/users'
import { SubmitModal } from '../components/SubmitModal'

const SUBJECT_TYPE_OPTIONS = [
  { label: '用户', value: 'user' },
  { label: '部门', value: 'org_unit' },
]

const EXHAUST_ACTION: Record<string, { text: string; color: string }> = {
  block: { text: '硬拦截', color: 'red' },
  allow_overage: { text: '软提醒', color: 'orange' },
}

/** 部门树拍平为下拉选项(缩进表达层级) */
function flattenOrgTree(nodes: OrgUnitTreeNode[], depth = 0): { label: string; value: string }[] {
  return (nodes ?? []).flatMap(n => [
    { label: `${'　'.repeat(depth)}${n.name}`, value: n.id },
    ...flattenOrgTree(n.children ?? [], depth + 1),
  ])
}

/** 额度授权表单值;range 结束日期允许为空(长期有效) */
interface GrantFormValues {
  subjectType: string
  subjectId: string
  modelId: string
  monthlyLimitTokens: number
  range?: [Dayjs | null, Dayjs | null] | null
}

/** 路由顺位项表单值(priority 由行序生成) */
interface RouteItemFormValue {
  sourceType: string
  sourceId: string
}

interface RouteFormValues {
  userId: string
  modelId: string
  exhaustAction: string
  items: RouteItemFormValue[]
}

export default function LlmQuotasPage() {
  const { message } = App.useApp()
  const [grants, setGrants] = useState<QuotaGrantDto[]>([])
  const [routes, setRoutes] = useState<UserModelRouteDto[]>([])
  const [models, setModels] = useState<EnterpriseModelDto[]>([])
  const [users, setUsers] = useState<UserDto[]>([])
  const [orgTree, setOrgTree] = useState<OrgUnitTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [grantTarget, setGrantTarget] = useState<QuotaGrantDto | null>(null)
  const [grantModalOpen, setGrantModalOpen] = useState(false)
  const [grantSaving, setGrantSaving] = useState(false)
  const [grantForm] = Form.useForm<GrantFormValues>()
  const grantSubjectType = Form.useWatch('subjectType', grantForm)
  const [routeTarget, setRouteTarget] = useState<UserModelRouteDto | null>(null)
  const [routeModalOpen, setRouteModalOpen] = useState(false)
  const [routeSaving, setRouteSaving] = useState(false)
  const [routeForm] = Form.useForm<RouteFormValues>()
  const routeModelId = Form.useWatch('modelId', routeForm)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [grantList, routeList, modelList, userList, tree] = await Promise.all([
        llmApi.listGrants(),
        llmApi.listRoutes(),
        llmApi.listModels(),
        usersApi.list({ status: 'active', limit: 200 }),
        orgUnitsApi.tree(),
      ])
      setGrants(grantList ?? [])
      setRoutes(routeList ?? [])
      setModels(modelList ?? [])
      setUsers(userList ?? [])
      setOrgTree(tree ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const userOptions = users.map(u => ({
    label: `${u.displayName || u.loginName}(${u.loginName})`,
    value: u.id,
  }))
  const orgOptions = flattenOrgTree(orgTree)
  const modelOptions = models.map(m => ({ label: `${m.displayName} — (${m.gatewayModelName})`, value: m.id }))

  const subjectOptions = (subjectType: string | undefined) =>
    subjectType === 'org_unit' ? orgOptions : userOptions

  /** 路由顺位项的额度池选项:仅列出所选模型下有生效授权的池(个人池=用户授权,部门池=部门授权),口径对齐 findEffectiveGrant */
  const poolOptions = (sourceType: string | undefined, modelId: string | undefined) => {
    if (!sourceType || !modelId) {
      return []
    }
    const today = dayjs().format('YYYY-MM-DD')
    const byId = new Map<string, string>()
    for (const g of grants) {
      if (g.enabled && g.modelId === modelId && g.subjectType === sourceType
        && (!g.effectiveFrom || g.effectiveFrom <= today)
        && (!g.effectiveTo || g.effectiveTo >= today)) {
        byId.set(g.subjectId, g.subjectName)
      }
    }
    return [...byId.entries()].map(([value, label]) => ({ label, value }))
  }

  // ---------- 额度授权 ----------

  const openGrantCreate = () => {
    setGrantTarget(null)
    setGrantModalOpen(true)
    grantForm.setFieldsValue({
      subjectType: 'user',
      subjectId: undefined,
      modelId: undefined,
      monthlyLimitTokens: 1_000_000,
    })
    // setFieldsValue 的 RecursivePartial 把 range 元组降级为纯数组,null 赋不进去;用 any 形参的 setFieldValue 清空
    grantForm.setFieldValue('range', null)
  }

  const openGrantEdit = (grant: QuotaGrantDto) => {
    setGrantTarget(grant)
    setGrantModalOpen(true)
    grantForm.setFieldsValue({
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      modelId: grant.modelId,
      monthlyLimitTokens: grant.monthlyLimitTokens,
    })
    grantForm.setFieldValue('range', null)
  }

  const submitGrant = async () => {
    const values = await grantForm.validateFields()
    const [from, to] = values.range ?? [null, null]
    setGrantSaving(true)
    try {
      if (grantTarget) {
        const body: UpdateGrantRequest = {
          monthlyLimitTokens: values.monthlyLimitTokens,
          effectiveFrom: from ? from.format('YYYY-MM-DD') : undefined,
          effectiveTo: to ? to.format('YYYY-MM-DD') : null,
        }
        await llmApi.updateGrant(grantTarget.id, body)
        message.success('已更新额度授权')
      } else {
        const body: CreateGrantRequest = {
          subjectType: values.subjectType,
          subjectId: values.subjectId,
          modelId: values.modelId,
          monthlyLimitTokens: values.monthlyLimitTokens,
          effectiveFrom: from ? from.format('YYYY-MM-DD') : undefined,
          effectiveTo: to ? to.format('YYYY-MM-DD') : null,
        }
        await llmApi.createGrant(body)
        message.success('已创建额度授权')
      }
      setGrantModalOpen(false)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存额度授权失败')
    } finally {
      setGrantSaving(false)
    }
  }

  const toggleGrant = async (grant: QuotaGrantDto) => {
    try {
      if (grant.enabled) {
        await llmApi.disableGrant(grant.id)
        message.success('已停用额度授权')
      } else {
        await llmApi.enableGrant(grant.id)
        message.success('已启用额度授权')
      }
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  // ---------- 池子下钻 ----------

  const [poolDrill, setPoolDrill] = useState<QuotaGrantDto | null>(null)
  const [poolUsers, setPoolUsers] = useState<UsageSummaryRow[]>([])
  const [poolUsersLoading, setPoolUsersLoading] = useState(false)

  /** 打开池子下钻:加载当前自然月内使用该池的发起人消耗列表,总消耗倒序 */
  const openPoolDrill = async (grant: QuotaGrantDto) => {
    setPoolDrill(grant)
    setPoolUsersLoading(true)
    try {
      const rows = await llmApi.usagePoolUsers(grant.subjectType, grant.subjectId, grant.modelId, dayjs().format('YYYY-MM'))
      setPoolUsers(rows ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载池子用量失败')
    } finally {
      setPoolUsersLoading(false)
    }
  }

  const poolUsersMax = poolUsers[0]?.totalTokens ?? 0
  const poolUsersTotal = poolUsers.reduce((sum, r) => sum + r.totalTokens, 0)

  const grantColumns: ColumnsType<QuotaGrantDto> = [
    {
      title: '对象类型',
      dataIndex: 'subjectType',
      key: 'subjectType',
      width: 90,
      render: (v: string) =>
        v === 'user' ? <Tag color="blue">用户</Tag> : <Tag color="cyan">部门</Tag>,
    },
    {
      title: '对象',
      dataIndex: 'subjectName',
      key: 'subjectName',
      render: (v: string, grant) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: 'auto' }}
          title="点击查看本周期使用该池的用户"
          onClick={() => void openPoolDrill(grant)}
        >
          {v}
        </Button>
      ),
    },
    { title: '模型', dataIndex: 'modelDisplayName', key: 'modelDisplayName' },
    {
      title: '月度额度(token)',
      dataIndex: 'monthlyLimitTokens',
      key: 'monthlyLimitTokens',
      align: 'right',
      render: (v: number) => (v === -1 ? '不限' : v.toLocaleString()),
    },
    {
      title: '当前周期已消耗(token)',
      dataIndex: 'periodConsumedTokens',
      key: 'periodConsumedTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '当前周期剩余(token)',
      dataIndex: 'periodRemainingTokens',
      key: 'periodRemainingTokens',
      align: 'right',
      // -1 是「不限量」哨兵值;其他负数表示软提醒策略下已透支(剩余 = 快照额度 - 消耗 - 预留)
      render: (v: number) => (v === -1 ? '不限量' : v.toLocaleString()),
    },
    {
      title: '生效区间',
      key: 'effectiveRange',
      render: (_, grant) =>
        `${grant.effectiveFrom ?? '即日'} ~ ${grant.effectiveTo ?? '长期'}`,
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
      width: 160,
      render: (_, grant) => (
        <Space size="small">
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openGrantEdit(grant)}>
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => toggleGrant(grant)}>
            {grant.enabled ? '停用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ]

  // ---------- 用户路由 ----------

  const openRouteCreate = () => {
    setRouteTarget(null)
    setRouteModalOpen(true)
    routeForm.setFieldsValue({
      userId: undefined,
      modelId: undefined,
      exhaustAction: 'block',
      items: [{ sourceType: 'user', sourceId: undefined as unknown as string }],
    })
  }

  const openRouteEdit = (route: UserModelRouteDto) => {
    setRouteTarget(route)
    setRouteModalOpen(true)
    routeForm.setFieldsValue({
      userId: route.userId,
      modelId: route.modelId,
      exhaustAction: route.exhaustAction,
      items: (route.items ?? []).map(i => ({ sourceType: i.sourceType, sourceId: i.sourceId })),
    })
  }

  const submitRoute = async () => {
    const values = await routeForm.validateFields()
    const items: RouteItemParam[] = (values.items ?? []).map((item, idx) => ({
      priority: idx + 1,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
    }))
    setRouteSaving(true)
    try {
      if (routeTarget) {
        const body: UpdateRouteRequest = {
          exhaustAction: values.exhaustAction,
          items,
        }
        await llmApi.updateRoute(routeTarget.id, body)
        message.success('已更新用户路由')
      } else {
        const body: CreateRouteRequest = {
          userId: values.userId,
          modelId: values.modelId,
          exhaustAction: values.exhaustAction,
          items,
        }
        await llmApi.createRoute(body)
        message.success('已创建用户路由')
      }
      setRouteModalOpen(false)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存用户路由失败')
    } finally {
      setRouteSaving(false)
    }
  }

  const toggleRoute = async (route: UserModelRouteDto) => {
    try {
      await llmApi.updateRoute(route.id, { enabled: !route.enabled })
      message.success(route.enabled ? '已停用路由' : '已启用路由')
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  const routeColumns: ColumnsType<UserModelRouteDto> = [
    { title: '用户', dataIndex: 'userDisplayName', key: 'userDisplayName' },
    { title: '模型', dataIndex: 'modelDisplayName', key: 'modelDisplayName' },
    {
      title: '用尽策略',
      dataIndex: 'exhaustAction',
      key: 'exhaustAction',
      width: 100,
      render: (v: string) => {
        const meta = EXHAUST_ACTION[v]
        return meta ? <Tag color={meta.color}>{meta.text}</Tag> : <Tag>{v}</Tag>
      },
    },
    {
      title: '扣费顺位',
      key: 'items',
      render: (_, route) =>
        (route.items ?? []).length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          (route.items ?? [])
            .map(i => `${i.priority}.${i.sourceName}${i.sourceType === 'user' ? '(个人)' : '(部门)'}`)
            .join(' → ')
        ),
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
      width: 160,
      render: (_, route) => (
        <Space size="small">
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openRouteEdit(route)}>
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => toggleRoute(route)}>
            {route.enabled ? '停用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>额度配置</Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
      </Space>
      <Tabs
        items={[
          {
            key: 'grants',
            label: '额度授权',
            children: (
              <Card
                title="月度额度授权"
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={openGrantCreate}>
                    新建授权
                  </Button>
                }
              >
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                  额度授权定义用户/部门对某个模型的月度 token 上限;-1 表示不限量,0 表示当月不可用。用户个人池与部门池并存,扣减顺序由用户路由的顺位项决定。
                </Typography.Paragraph>
                <Table<QuotaGrantDto>
                  rowKey="id"
                  columns={grantColumns}
                  dataSource={grants}
                  loading={loading}
                  pagination={{ pageSize: 20, showSizeChanger: true }}
                />
              </Card>
            ),
          },
          {
            key: 'routes',
            label: '用户路由',
            children: (
              <Card
                title="用户模型路由"
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={openRouteCreate}>
                    新建路由
                  </Button>
                }
              >
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                  路由定义某用户使用某模型时依次尝试的额度池(个人/部门)与额度用尽后的处置策略;同一用户同一模型仅一条路由。
                </Typography.Paragraph>
                <Table<UserModelRouteDto>
                  rowKey="id"
                  columns={routeColumns}
                  dataSource={routes}
                  loading={loading}
                  pagination={{ pageSize: 20, showSizeChanger: true }}
                />
              </Card>
            ),
          },
        ]}
      />
      <Drawer
        width={520}
        open={!!poolDrill}
        onClose={() => setPoolDrill(null)}
        destroyOnClose
        title={
          poolDrill ? (
            <Space size={8} wrap>
              <span>池子用量 · {poolDrill.subjectName}</span>
              <Tag color={poolDrill.subjectType === 'user' ? 'blue' : 'cyan'}>
                {poolDrill.subjectType === 'user' ? '个人池' : '部门池'}
              </Tag>
              <Tag color="geekblue">{poolDrill.modelDisplayName}</Tag>
            </Space>
          ) : (
            '池子用量'
          )
        }
      >
        {poolDrill ? (
          <Spin spinning={poolUsersLoading}>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
              统计周期:{dayjs().format('YYYY-MM')}(自然月);仅统计已完成扣账的请求,按发起人聚合。
            </Typography.Paragraph>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              {[
                {
                  label: '月度额度',
                  value:
                    poolDrill.monthlyLimitTokens === -1
                      ? '不限量'
                      : poolDrill.monthlyLimitTokens.toLocaleString(),
                  danger: false,
                },
                {
                  label: '本周期已消耗',
                  value: poolDrill.periodConsumedTokens.toLocaleString(),
                  danger: false,
                },
                {
                  label: '本周期剩余',
                  value:
                    poolDrill.periodRemainingTokens === -1
                      ? '不限量'
                      : poolDrill.periodRemainingTokens.toLocaleString(),
                  danger: poolDrill.periodRemainingTokens !== -1 && poolDrill.periodRemainingTokens < 0,
                },
              ].map(item => (
                <div key={item.label} style={{ flex: 1, padding: '10px 12px', borderRadius: 8, background: '#fafafa' }}>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>{item.label}</div>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: item.danger ? '#d46b08' : undefined,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
            {poolDrill.periodRemainingTokens !== -1 && poolDrill.periodRemainingTokens < 0 && (
              <Typography.Paragraph type="warning" style={{ fontSize: 12 }}>
                该池已透支:软提醒策略下超出的部分仍会记账,剩余为负值。
              </Typography.Paragraph>
            )}
            {poolUsers.length === 0 && !poolUsersLoading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本周期暂无消耗记录" />
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {poolUsers.map((row, idx) => {
                    const badgeColor =
                      idx === 0 ? '#faad14' : idx === 1 ? '#bfbfbf' : idx === 2 ? '#d48806' : undefined
                    return (
                      <div key={row.subjectId}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {badgeColor ? (
                            <span
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: '50%',
                                background: badgeColor,
                                color: '#fff',
                                fontSize: 12,
                                fontWeight: 600,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              {idx + 1}
                            </span>
                          ) : (
                            <span style={{ width: 22, textAlign: 'center', color: '#8c8c8c', fontSize: 12, flexShrink: 0 }}>
                              {idx + 1}
                            </span>
                          )}
                          <span
                            style={{
                              flex: 1,
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.subjectName || row.subjectId}
                          </span>
                          {row.overageTokens > 0 && <Tag color="orange" style={{ marginInlineEnd: 0 }}>超额</Tag>}
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                            {row.totalTokens.toLocaleString()}
                          </span>
                          <span
                            style={{
                              width: 48,
                              textAlign: 'right',
                              color: '#8c8c8c',
                              fontSize: 12,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {poolUsersTotal > 0 ? `${((row.totalTokens / poolUsersTotal) * 100).toFixed(1)}%` : '-'}
                          </span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: '#f0f0f0', margin: '6px 0 0 30px' }}>
                          <div
                            style={{
                              width: `${poolUsersMax > 0 ? (row.totalTokens / poolUsersMax) * 100 : 0}%`,
                              height: '100%',
                              borderRadius: 3,
                              background: 'linear-gradient(90deg, #1677ff, #69b1ff)',
                            }}
                          />
                        </div>
                        <div style={{ fontSize: 12, color: '#8c8c8c', marginLeft: 30, marginTop: 4 }}>
                          请求 {row.requestCount.toLocaleString()} 次 · 输入 {row.promptTokens.toLocaleString()} / 输出{' '}
                          {row.completionTokens.toLocaleString()}
                          {row.overageTokens > 0 && (
                            <span style={{ color: '#d46b08' }}> · 超额 {row.overageTokens.toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
                  共 {poolUsers.length} 名发起人,合计消耗 {poolUsersTotal.toLocaleString()} tokens。
                </Typography.Paragraph>
              </>
            )}
          </Spin>
        ) : null}
      </Drawer>
      <SubmitModal
        title={grantTarget ? `编辑额度授权(${grantTarget.subjectName} / ${grantTarget.modelDisplayName})` : '新建额度授权'}
        open={grantModalOpen}
        onCancel={() => setGrantModalOpen(false)}
        onOk={submitGrant}
        submitting={grantSaving}
        destroyOnClose
      >
        <Form form={grantForm} layout="vertical">
          <Form.Item
            name="subjectType"
            label="对象类型"
            rules={[{ required: true, message: '请选择对象类型' }]}
          >
            <Radio.Group
              options={SUBJECT_TYPE_OPTIONS}
              optionType="button"
              disabled={!!grantTarget}
              onChange={() => grantForm.setFieldValue('subjectId', undefined)}
            />
          </Form.Item>
          <Form.Item
            name="subjectId"
            label="授权对象"
            rules={[{ required: true, message: '请选择授权对象' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={subjectOptions(grantSubjectType)}
              placeholder={grantSubjectType === 'org_unit' ? '选择部门' : '选择用户'}
              disabled={!!grantTarget}
            />
          </Form.Item>
          <Form.Item
            name="modelId"
            label="模型"
            rules={[{ required: true, message: '请选择模型' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={modelOptions}
              placeholder="选择企业模型"
              disabled={!!grantTarget}
            />
          </Form.Item>
          <Form.Item
            name="monthlyLimitTokens"
            label="月度额度(token)"
            tooltip="每月可消耗的 token 上限;-1 表示不限量,0 表示当月不可用"
            rules={[{ required: true, message: '请输入月度额度' }]}
          >
            <InputNumber style={{ width: '100%' }} min={-1} precision={0} />
          </Form.Item>
          <Form.Item name="range" label="生效区间(结束日期可留空=长期有效)">
            <DatePicker.RangePicker style={{ width: '100%' }} allowEmpty={[false, true]} />
          </Form.Item>
          {grantTarget && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              留空生效区间表示保持原区间不变;仅填开始日期表示自该日起长期有效。
            </Typography.Paragraph>
          )}
        </Form>
      </SubmitModal>
      <SubmitModal
        title={routeTarget ? `编辑路由(${routeTarget.userDisplayName} / ${routeTarget.modelDisplayName})` : '新建用户路由'}
        open={routeModalOpen}
        onCancel={() => setRouteModalOpen(false)}
        onOk={submitRoute}
        submitting={routeSaving}
        destroyOnClose
        width={640}
      >
        <Form form={routeForm} layout="vertical">
          <Form.Item
            name="userId"
            label="用户"
            rules={[{ required: true, message: '请选择用户' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={userOptions}
              placeholder="选择用户"
              disabled={!!routeTarget}
            />
          </Form.Item>
          <Form.Item
            name="modelId"
            label="模型"
            rules={[{ required: true, message: '请选择模型' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={modelOptions}
              placeholder="选择企业模型"
              disabled={!!routeTarget}
              onChange={() => {
                // 切换模型后原顺位项的池不再匹配新模型,清空来源待重选
                const items = (routeForm.getFieldValue('items') as RouteItemFormValue[]) ?? []
                routeForm.setFieldValue('items', items.map(i => ({ ...i, sourceId: undefined as unknown as string })))
              }}
            />
          </Form.Item>
          <Form.Item
            name="exhaustAction"
            label="额度用尽策略"
            rules={[{ required: true, message: '请选择用尽策略' }]}
            extra="硬拦截:所有额度池不足时直接拒绝请求;软提醒:允许继续使用并记为超额。"
          >
            <Radio.Group>
              <Radio value="block">硬拦截</Radio>
              <Radio value="allow_overage">软提醒</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                <Typography.Text strong>扣费顺位(按顺序尝试扣减)</Typography.Text>
                {fields.map((field, idx) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex', marginTop: 8 }} wrap>
                    <Typography.Text type="secondary" style={{ width: 32 }}>
                      {idx + 1}.
                    </Typography.Text>
                    <Form.Item
                      name={[field.name, 'sourceType']}
                      rules={[{ required: true, message: '请选择来源类型' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select
                        style={{ width: 120 }}
                        options={SUBJECT_TYPE_OPTIONS}
                        onChange={() => {
                          const items = routeForm.getFieldValue('items') as RouteItemFormValue[]
                          items[field.name] = { ...items[field.name], sourceId: undefined as unknown as string }
                          routeForm.setFieldValue('items', items)
                        }}
                      />
                    </Form.Item>
                    <Form.Item
                      noStyle
                      shouldUpdate={(prev: RouteFormValues, next: RouteFormValues) =>
                        prev.items?.[field.name]?.sourceType !== next.items?.[field.name]?.sourceType
                        || prev.modelId !== next.modelId
                      }
                    >
                      {({ getFieldValue }) => {
                        const items = (getFieldValue('items') as RouteItemFormValue[] | undefined) ?? []
                        const sourceType = items[field.name]?.sourceType
                        const sourceId = items[field.name]?.sourceId
                        let options = poolOptions(sourceType, routeModelId)
                        if (sourceId && !options.some(o => o.value === sourceId)) {
                          // 编辑态兜底:顺位项引用的池在所选模型下已无生效授权时,保留原值并标记失效
                          const saved = routeTarget?.items?.find(i => i.sourceType === sourceType && i.sourceId === sourceId)
                          options = [{ label: `${saved?.sourceName ?? sourceId}(授权已失效)`, value: sourceId }, ...options]
                        }
                        return (
                          <Form.Item
                            name={[field.name, 'sourceId']}
                            rules={[{ required: true, message: '请选择额度池' }]}
                            style={{ marginBottom: 0 }}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              style={{ width: 280 }}
                              options={options}
                              placeholder={sourceType === 'org_unit' ? '选择部门池' : '选择个人池'}
                              notFoundContent={routeModelId ? '该模型暂无可用额度池' : '请先选择模型'}
                            />
                          </Form.Item>
                        )
                      }}
                    </Form.Item>
                    <Button
                      size="small"
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={fields.length <= 1}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  style={{ marginTop: 8 }}
                  onClick={() => add({ sourceType: 'user' })}
                >
                  添加顺位项
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </SubmitModal>
    </div>
  )
}
