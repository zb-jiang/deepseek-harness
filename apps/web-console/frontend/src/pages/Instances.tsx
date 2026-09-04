import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type ApplicationDto, appsApi } from '../api/apps'
import { instancesApi, type ProcessInstanceDto } from '../api/process-instances'

export default function InstancesPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()

  const [data, setData] = useState<ProcessInstanceDto[]>([])
  const [apps, setApps] = useState<ApplicationDto[]>([])
  const [loading, setLoading] = useState(false)
  const [appIdFilter, setAppIdFilter] = useState<string | undefined>()

  const appMap = useMemo(() => {
    const m = new Map<string, ApplicationDto>()
    for (const a of apps) m.set(a.id, a)
    return m
  }, [apps])

  const loadApps = useCallback(async () => {
    try {
      const list = await appsApi.list({ limit: 500 })
      setApps(list ?? [])
    } catch (e) {
      console.warn('[instances] load apps failed', e)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await instancesApi.list({ appId: appIdFilter, start: 0, size: 200 })
      setData(list ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载实例失败')
    } finally {
      setLoading(false)
    }
  }, [appIdFilter, message])

  useEffect(() => {
    void loadApps()
  }, [loadApps])

  useEffect(() => {
    void load()
  }, [load])

  const appOptions = apps.map(a => ({ label: a.name, value: a.id }))

  const columns: ColumnsType<ProcessInstanceDto> = [
    {
      title: '实例 ID',
      dataIndex: 'id',
      key: 'id',
      render: (v: string) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/instances/${v}`)}>
          <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>
        </Button>
      ),
    },
    {
      title: '流程名',
      key: 'workflowName',
      render: (_, inst) => inst.workflowName ?? inst.processDefinitionName ?? inst.processDefinitionKey ?? '-',
    },
    {
      title: '所属应用',
      dataIndex: 'appId',
      key: 'appId',
      render: (v: string | null) => (v ? appMap.get(v)?.name ?? v.slice(0, 8) : '-'),
    },
    {
      title: '业务键',
      dataIndex: 'businessKey',
      key: 'businessKey',
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '发起人',
      key: 'startUserId',
      render: (_, inst) => inst.startUserName ?? inst.startUserId ?? '-',
    },
    {
      title: '启动时间',
      dataIndex: 'startTime',
      key: 'startTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, inst) => {
        if (inst.ended) {
          return (
            <Tag color={inst.deleteReason ? 'red' : 'green'}>
              {inst.deleteReason ? '已终止' : '已完成'}
            </Tag>
          )
        }
        return <Tag color={inst.suspended ? 'orange' : 'blue'}>{inst.suspended ? '已挂起' : '运行中'}</Tag>
      },
    },
    {
      title: '结束时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, inst) => (
        <Button size="small" type="link" onClick={() => navigate(`/instances/${inst.id}`)}>
          详情
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <ClockCircleOutlined /> 流程实例
        </Typography.Title>
        <Select
          allowClear
          placeholder="按应用过滤"
          style={{ width: 200 }}
          value={appIdFilter}
          onChange={v => setAppIdFilter(v)}
          options={appOptions}
          showSearch
          optionFilterProp="label"
        />
        <Button onClick={() => load()}>刷新</Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate('/workflows')}
        >
          从流程定义发起
        </Button>
      </Space>
      <Table<ProcessInstanceDto>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        size="small"
        scroll={{ x: 1000 }}
      />
    </div>
  )
}
