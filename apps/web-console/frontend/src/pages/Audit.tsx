import { ReloadOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type AuditEventDto, auditApi } from '../api/audit'
import { usersApi } from '../api/users'

/** 事件类型 → 标签颜色;清单与后端 AuditService.record 的 eventType 对齐 */
const EVENT_COLOR: Record<string, string> = {
  USER_APPROVE: 'green',
  USER_DISABLE: 'red',
  USER_LOCK: 'orange',
  USER_ACTIVATE: 'blue',
  USER_UPDATE_ROLES: 'purple',
  USER_ASSIGN_ORG_UNITS: 'geekblue',
  APP_CREATE: 'cyan',
  APP_UPDATE: 'default',
  APP_ARCHIVE: 'red',
  ROLE_CREATE: 'cyan',
  ROLE_UPDATE: 'default',
  ROLE_DISABLE: 'red',
  ROLE_ACTIVATE: 'green',
  MEMBERSHIP_CREATE: 'blue',
  MEMBERSHIP_UPDATE: 'default',
  MEMBERSHIP_DISABLE: 'red',
  MEMBERSHIP_ACTIVATE: 'green',
  ORG_UNIT_CREATE: 'cyan',
  ORG_UNIT_UPDATE: 'default',
  ORG_UNIT_DELETE: 'red',
  ORG_UNIT_MEMBER_ADD: 'blue',
  ORG_UNIT_MEMBER_REMOVE: 'orange',
  WORKFLOW_CREATE: 'cyan',
  WORKFLOW_UPDATE_DRAFT: 'default',
  WORKFLOW_UPDATE_META: 'default',
  WORKFLOW_PUBLISH: 'green',
  WORKFLOW_DISABLE: 'red',
  WORKFLOW_ARCHIVE: 'red',
  PROCESS_INSTANCE_START: 'blue',
  PROCESS_INSTANCE_TERMINATE: 'red',
  TASK_COMPLETE: 'green',
  KB_CREATE: 'cyan',
  KB_FOLDER_CREATE: 'cyan',
  KB_FOLDER_UPDATE: 'default',
  KB_FOLDER_DELETE: 'red',
  KB_DOCUMENT_UPLOAD: 'blue',
  KB_DOCUMENT_REPARSE: 'gold',
  KB_DOCUMENT_DELETE: 'red',
  LLM_MODEL_CREATE: 'cyan',
  LLM_MODEL_UPDATE: 'default',
  LLM_MODEL_ENABLE: 'green',
  LLM_MODEL_DISABLE: 'red',
  LLM_MODEL_DELETE: 'red',
  LLM_ROUTE_UPSERT: 'blue',
  LLM_ROUTE_UPDATE: 'default',
  LLM_QUOTA_GRANT_CREATE: 'cyan',
  LLM_QUOTA_GRANT_UPDATE: 'default',
  LLM_QUOTA_GRANT_ENABLE: 'green',
  LLM_QUOTA_GRANT_DISABLE: 'red',
}

/** 审计事件 targetType → 中文标签映射 */
const TARGET_TYPE_LABEL: Record<string, string> = {
  platform_user: '用户',
  application: '应用',
  app_role: '角色',
  app_membership: '成员',
  org_unit: '组织',
  workflow_definition: '流程',
  process_instance: '实例',
  kb_document: '文档',
  kb_folder: '文件夹',
  llm_enterprise_model: '模型',
  llm_user_model_route: '模型路由',
  llm_quota_grant: '额度授权',
}

const EVENT_OPTIONS = Object.keys(EVENT_COLOR).map(k => ({ label: k, value: k }))

const TARGET_OPTIONS = Object.entries(TARGET_TYPE_LABEL).map(([value, label]) => ({ value, label }))

/** 时间段快捷项(与用量分析·调用明细一致) */
const RANGE_PRESETS: { label: string; value: () => [Dayjs, Dayjs] }[] = [
  { label: '今天', value: () => [dayjs().startOf('day'), dayjs()] },
  { label: '本周', value: () => [dayjs().startOf('week'), dayjs()] },
  { label: '本月', value: () => [dayjs().startOf('month'), dayjs()] },
  { label: '近 7 天', value: () => [dayjs().subtract(6, 'day').startOf('day'), dayjs()] },
  { label: '近 30 天', value: () => [dayjs().subtract(29, 'day').startOf('day'), dayjs()] },
]

export default function AuditPage() {
  const { message } = App.useApp()
  const [data, setData] = useState<AuditEventDto[]>([])
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>()
  const [operatorFilter, setOperatorFilter] = useState<string | undefined>()
  const [targetTypeFilter, setTargetTypeFilter] = useState<string | undefined>()
  const [operators, setOperators] = useState<{ id: string; name: string }[]>([])

  // 操作人下拉选项取全量平台用户;失败只留空选项,不阻塞审计列表
  const loadOperators = useCallback(async () => {
    try {
      const users = await usersApi.list({ limit: 500 })
      setOperators((users ?? []).map(u => ({ id: u.id, name: u.displayName ?? u.loginName })))
    } catch (e) {
      console.warn('加载操作人下拉选项失败', e)
    }
  }, [])

  useEffect(() => {
    void loadOperators()
  }, [loadOperators])

  const operatorOptions = useMemo(
    () => operators.map(o => ({ value: o.id, label: o.name })),
    [operators],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 区间按整天换算:from=起始日 0 点,to=结束日次日 0 点(排他上界),清空=全部时间(与调用明细一致)
      const from = range?.[0].startOf('day').toISOString()
      const to = range?.[1].add(1, 'day').startOf('day').toISOString()
      const list = await auditApi.list({
        from,
        to,
        eventType: eventTypeFilter,
        operatorId: operatorFilter,
        targetType: targetTypeFilter,
        limit: 200,
      })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载审计失败')
    } finally {
      setLoading(false)
    }
  }, [range, eventTypeFilter, operatorFilter, targetTypeFilter, message])

  useEffect(() => {
    void load()
  }, [load])

  const columns: ColumnsType<AuditEventDto> = [
    {
      title: '时间',
      dataIndex: 'occurredAt',
      key: 'occurredAt',
      width: 170,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '事件',
      dataIndex: 'eventType',
      key: 'eventType',
      width: 210,
      render: (v: string) => <Tag color={EVENT_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '操作人',
      dataIndex: 'operatorDisplayName',
      key: 'operatorDisplayName',
      width: 120,
      render: (_v: string | null, row: AuditEventDto) =>
        row.operatorDisplayName
          ? row.operatorDisplayName
          : row.operatorId
            ? row.operatorId.slice(0, 8)
            : <Typography.Text type="secondary">系统</Typography.Text>,
    },
    {
      title: '目标',
      dataIndex: 'targetType',
      key: 'targetType',
      width: 100,
      render: (v: string | null) =>
        v ? <Tag>{TARGET_TYPE_LABEL[v] ?? v}</Tag> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '详情',
      key: 'details',
      render: (_v: unknown, row: AuditEventDto) => {
        if (!row.details || Object.keys(row.details).length === 0) {
          return <Typography.Text type="secondary">-</Typography.Text>
        }
        const json = JSON.stringify(row.details)
        return (
          <Tooltip
            title={
              <pre
                style={{
                  margin: 0,
                  maxHeight: 320,
                  overflow: 'auto',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(row.details, null, 2)}
              </pre>
            }
          >
            <Typography.Text
              code
              ellipsis
              copyable={{ text: json, tooltips: ['复制', '已复制'] }}
              style={{ fontSize: 12, maxWidth: '100%' }}
            >
              {json}
            </Typography.Text>
          </Tooltip>
        )
      },
    },
  ]

  return (
    <div>
      <Space align="baseline" style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>审计日志</Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          全平台敏感操作留痕，最多展示最近 200 条
        </Typography.Text>
      </Space>
      <Card>
        <Space size={8} wrap style={{ marginBottom: 16 }}>
          <DatePicker.RangePicker
            value={range}
            presets={RANGE_PRESETS}
            allowClear
            placeholder={['开始日期', '结束日期']}
            onChange={v => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按事件类型筛选"
            style={{ width: 200 }}
            value={eventTypeFilter}
            onChange={v => setEventTypeFilter(v)}
            options={EVENT_OPTIONS}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按操作人筛选"
            style={{ width: 140 }}
            value={operatorFilter}
            onChange={v => setOperatorFilter(v)}
            options={operatorOptions}
          />
          <Select
            allowClear
            placeholder="按目标筛选"
            style={{ width: 120 }}
            value={targetTypeFilter}
            onChange={v => setTargetTypeFilter(v)}
            options={TARGET_OPTIONS}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()} />
        </Space>
        <Table<AuditEventDto>
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t.toLocaleString()} 条` }}
          size="small"
          scroll={{ x: 1000 }}
        />
      </Card>
    </div>
  )
}
