import { App, Button, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { type AuditEventDto, auditApi } from '../api/audit'

const EVENT_COLOR: Record<string, string> = {
  USER_APPROVE: 'green',
  USER_DISABLE: 'red',
  USER_LOCK: 'orange',
  USER_ACTIVATE: 'blue',
  USER_UPDATE_ROLES: 'purple',
  APP_CREATE: 'cyan',
  APP_UPDATE: 'default',
  APP_ACTIVATE: 'green',
  APP_ARCHIVE: 'red',
  ROLE_CREATE: 'cyan',
  ROLE_UPDATE: 'default',
  ROLE_DISABLE: 'red',
  ROLE_ACTIVATE: 'green',
  MEMBERSHIP_UPSERT: 'blue',
  MEMBERSHIP_DISABLE: 'red',
  MEMBERSHIP_ACTIVATE: 'green',
  WORKFLOW_CREATE: 'cyan',
  WORKFLOW_UPDATE_DRAFT: 'default',
  WORKFLOW_PUBLISH: 'green',
  WORKFLOW_DISABLE: 'red',
  WORKFLOW_ARCHIVE: 'red',
  PROCESS_INSTANCE_START: 'blue',
  PROCESS_INSTANCE_TERMINATE: 'red',
  TASK_COMPLETE: 'green',
}

const EVENT_OPTIONS = Object.keys(EVENT_COLOR).map(k => ({ label: k, value: k }))

export default function AuditPage() {
  const { message } = App.useApp()
  const [data, setData] = useState<AuditEventDto[]>([])
  const [loading, setLoading] = useState(false)
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await auditApi.list({ eventType: eventTypeFilter, limit: 200 })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载审计失败')
    } finally {
      setLoading(false)
    }
  }, [eventTypeFilter, message])

  useEffect(() => {
    void load()
  }, [load])

  const columns: ColumnsType<AuditEventDto> = [
    {
      title: '时间',
      dataIndex: 'occurredAt',
      key: 'occurredAt',
      width: 160,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '事件',
      dataIndex: 'eventType',
      key: 'eventType',
      width: 220,
      render: (v: string) => <Tag color={EVENT_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '操作人',
      dataIndex: 'operatorId',
      key: 'operatorId',
      width: 120,
      render: (v: string | null) => (v ? v.slice(0, 8) : <Typography.Text type="secondary">系统</Typography.Text>),
    },
    {
      title: '目标用户',
      dataIndex: 'targetUserId',
      key: 'targetUserId',
      width: 120,
      render: (v: string | null) => (v ? v.slice(0, 8) : '-'),
    },
    {
      title: '详情',
      dataIndex: 'details',
      key: 'details',
      render: (v: Record<string, unknown> | null) =>
        v ? <Typography.Text code style={{ fontSize: 12 }}>{JSON.stringify(v)}</Typography.Text> : '-',
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>审计事件</Typography.Title>
        <Select
          allowClear
          placeholder="按事件类型过滤"
          style={{ width: 240 }}
          value={eventTypeFilter}
          onChange={v => setEventTypeFilter(v)}
          options={EVENT_OPTIONS}
          showSearch
        />
        <Button onClick={() => load()}>刷新</Button>
      </Space>
      <Table<AuditEventDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        size="small"
        scroll={{ x: 800 }}
      />
    </div>
  )
}
