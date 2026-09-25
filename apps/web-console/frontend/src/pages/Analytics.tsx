/**
 * 分析看板(设计 2026-09-25):业务分析 + 运维健康两个 tab。
 *
 * - 业务分析(system_admin + app_admin):概览卡/每日吞吐/办理人时效/节点热力图,
 *   数据经 web-console 代理引擎 /dsh/analytics/*;
 * - 运维健康(仅 system_admin):引擎指标实时卡 + 趋势折线,
 *   数据为 web-console 轮询落库的 dsh_metrics_sample。
 * 前端按角色显隐 tab;后端 @PreAuthorize 双保险(越权直接 403)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Typography,
} from 'antd'
import { Line } from '@ant-design/charts'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'
import { workflowsApi, type WorkflowDefinitionDto } from '../api/workflows'
import {
  analyticsApi,
  BACKEND_TASK_FAILED,
  BACKEND_TASK_SUCCESS,
  type ActivityStat,
  type AnalyticsOverview,
  type DailyVolume,
  type OpsSummary,
  type SeriesPoint,
  type TaskStat,
} from '../api/analytics'
import BpmnAnalyticsViewer, { formatMs } from '../bpmn/BpmnAnalyticsViewer'

const DAYS_OPTIONS = [7, 30, 90]

/**
 * Flowable procdefId 格式为 {key}:{version}:{id},从发布版本 id 解析流程 key
 * (引擎 /dsh/analytics 按 key 聚合跨部署版本)。
 */
function procdefKey(workflow: WorkflowDefinitionDto): string | null {
  const procdefId = workflow.publishedProcdefId
  if (!procdefId) return null
  const key = procdefId.split(':')[0]
  return key || null
}

/** 每日吞吐折线数据(双序列拉平为长表)。 */
function toVolumeSeries(volumes: DailyVolume[]) {
  return volumes.flatMap(v => [
    { date: v.date, value: v.started, type: '发起' },
    { date: v.date, value: v.completed, type: '完成' },
  ])
}

function BusinessTab() {
  const [workflows, setWorkflows] = useState<WorkflowDefinitionDto[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [volumes, setVolumes] = useState<DailyVolume[]>([])
  const [taskStats, setTaskStats] = useState<TaskStat[]>([])
  const [activityStats, setActivityStats] = useState<ActivityStat[]>([])
  const [bpmnXml, setBpmnXml] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    workflowsApi
      .list({ status: 'published', limit: 100 })
      .then((list) => {
        if (!cancelled) setWorkflows(list)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '流程定义加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const keyParam = selectedKey ?? undefined
      const [ov, dv, ts, as] = await Promise.all([
        analyticsApi.overview({ days, processDefinitionKey: keyParam }),
        analyticsApi.dailyVolumes({ days, processDefinitionKey: keyParam }),
        analyticsApi.taskStats({ days, processDefinitionKey: keyParam }),
        analyticsApi.activityStats({ days, processDefinitionKey: keyParam }),
      ])
      setOverview(ov)
      setVolumes(dv)
      setTaskStats(ts)
      setActivityStats(as)
      const workflow = workflows.find(w => procdefKey(w) === selectedKey)
      setBpmnXml(
        workflow?.publishedProcdefId ? await analyticsApi.bpmnXml(workflow.publishedProcdefId) : '',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '分析数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, selectedKey, workflows])

  useEffect(() => {
    void load()
  }, [load])

  const topSlowNodes = useMemo(
    () =>
      [...activityStats]
        .filter(s => s.activityType !== 'sequenceFlow' && s.avgDurationMs != null)
        .sort((a, b) => (b.avgDurationMs ?? 0) - (a.avgDurationMs ?? 0))
        .slice(0, 10),
    [activityStats],
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Select
          allowClear
          placeholder="全部流程"
          style={{ minWidth: 240 }}
          value={selectedKey}
          onChange={v => setSelectedKey(v ?? null)}
          options={workflows.map(w => ({ value: procdefKey(w) ?? w.id, label: w.name }))}
        />
        <Segmented
          value={days}
          onChange={v => setDays(v as number)}
          options={DAYS_OPTIONS.map(d => ({ label: `${d} 天`, value: d }))}
        />
        <Typography.Text type="secondary">统计窗口按发起时间截取</Typography.Text>
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <Row gutter={16}>
        <Col span={4}><Card size="small"><Statistic title="发起" value={overview?.started ?? 0} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="正常完成" value={overview?.completed ?? 0} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="运行中" value={overview?.running ?? 0} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已终止" value={overview?.terminated ?? 0} /></Card></Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="平均端到端时长" value={formatMs(overview?.avgDurationMs ?? null)} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="P95 端到端时长" value={formatMs(overview?.p95DurationMs ?? null)} />
          </Card>
        </Col>
      </Row>
      <Card size="small" title="每日吞吐">
        {volumes.length > 0 ? (
          <Line
            data={toVolumeSeries(volumes)}
            xField="date"
            yField="value"
            seriesField="type"
            height={260}
            smooth
          />
        ) : (
          <Empty description="窗口内无数据" />
        )}
      </Card>
      <Card size="small" title="节点时长热力图(选中具体流程后展示)">
        {bpmnXml ? (
          <BpmnAnalyticsViewer xml={bpmnXml} stats={activityStats} />
        ) : (
          <Empty description="选择具体流程定义后展示热力图" />
        )}
      </Card>
      <Row gutter={16}>
        <Col span={12}>
          <Card size="small" title="办理人时效榜(完成任务 Top 50)">
            <Table<TaskStat>
              size="small"
              rowKey="assignee"
              dataSource={taskStats}
              loading={loading}
              pagination={false}
              columns={[
                {
                  title: '办理人',
                  dataIndex: 'assignee',
                  render: (_, r) => r.displayName ?? r.assignee,
                },
                { title: '完成份数', dataIndex: 'count', width: 100 },
                {
                  title: '平均时长',
                  dataIndex: 'avgDurationMs',
                  width: 110,
                  render: v => formatMs(v),
                },
                {
                  title: '最长时长',
                  dataIndex: 'maxDurationMs',
                  width: 110,
                  render: v => formatMs(v),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="最慢节点 Top 10">
            <Table<ActivityStat>
              size="small"
              rowKey="activityId"
              dataSource={topSlowNodes}
              loading={loading}
              pagination={false}
              columns={[
                { title: '节点', dataIndex: 'activityName', render: (v, r) => v ?? r.activityId },
                { title: '类型', dataIndex: 'activityType', width: 110 },
                { title: '执行份数', dataIndex: 'count', width: 90 },
                {
                  title: '平均时长',
                  dataIndex: 'avgDurationMs',
                  width: 110,
                  render: v => formatMs(v),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  )
}

const OPS_WINDOW_OPTIONS = [
  { label: '近 1 小时', value: 1 },
  { label: '近 6 小时', value: 6 },
  { label: '近 24 小时', value: 24 },
]

const OPS_SERIES_METRICS = [
  { value: 'dsh.flowable.jobs.async', label: 'async job 积压' },
  { value: 'dsh.flowable.jobs.timer', label: 'timer job 积压' },
  { value: 'dsh.flowable.jobs.deadletter', label: 'dead-letter job 积压' },
  { value: 'dsh.flowable.jobs.suspended', label: '挂起 job 数' },
  { value: 'hikaricp.connections.active', label: '活跃连接数' },
  { value: 'jvm.memory.used', label: 'JVM 内存用量' },
  { value: 'dsh.task.escalation', label: '超时升级(累计)' },
  { value: BACKEND_TASK_SUCCESS, label: 'backend task 成功(累计)' },
  { value: BACKEND_TASK_FAILED, label: 'backend task 失败(累计)' },
]

function OpsTab() {
  const [summary, setSummary] = useState<OpsSummary | null>(null)
  const [metric, setMetric] = useState(OPS_SERIES_METRICS[0].value)
  const [windowHours, setWindowHours] = useState(6)
  const [series, setSeries] = useState<SeriesPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await analyticsApi.opsSummary())
    } catch (e) {
      setError(e instanceof Error ? e.message : '运维汇总加载失败')
    }
  }, [])

  const loadSeries = useCallback(async () => {
    setLoading(true)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - windowHours * 3600_000)
      const statistic = metric.includes('dsh.backend.task') || metric === 'dsh.task.escalation'
        ? 'COUNT'
        : 'VALUE'
      setSeries(
        await analyticsApi.opsSeries({
          metric,
          statistic,
          from: from.toISOString(),
          to: to.toISOString(),
        }),
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '指标序列加载失败')
    } finally {
      setLoading(false)
    }
  }, [metric, windowHours])

  useEffect(() => {
    void loadSummary()
    // 实时卡对齐轮询节奏(30s)刷新
    const timer = setInterval(() => void loadSummary(), 30_000)
    return () => clearInterval(timer)
  }, [loadSummary])

  useEffect(() => {
    void loadSeries()
  }, [loadSeries])

  const jobValue = (name: string) => summary?.latest[name] ?? '-'

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}
      <Row gutter={16}>
        <Col span={3}><Card size="small"><Statistic title="async job" value={jobValue('dsh.flowable.jobs.async')} /></Card></Col>
        <Col span={3}><Card size="small"><Statistic title="timer job" value={jobValue('dsh.flowable.jobs.timer')} /></Card></Col>
        <Col span={3}><Card size="small"><Statistic title="dead-letter job" value={jobValue('dsh.flowable.jobs.deadletter')} /></Card></Col>
        <Col span={3}><Card size="small"><Statistic title="挂起 job" value={jobValue('dsh.flowable.jobs.suspended')} /></Card></Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="backend task 成功率(1h)"
              value={summary?.backendTaskSuccessRate != null
                ? `${(summary.backendTaskSuccessRate * 100).toFixed(1)}%`
                : '-'}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="backend task 平均时延(1h)"
              value={formatMs(summary?.backendTaskAvgLatencyMs ?? null)}
            />
          </Card>
        </Col>
        <Col span={4}><Card size="small"><Statistic title="升级触发(1h)" value={summary?.escalationCount1h ?? '-'} /></Card></Col>
      </Row>
      <Card
        size="small"
        title="指标趋势"
        extra={
          <Space>
            <Select
              style={{ minWidth: 220 }}
              value={metric}
              onChange={setMetric}
              options={OPS_SERIES_METRICS}
            />
            <Segmented
              value={windowHours}
              onChange={v => setWindowHours(v as number)}
              options={OPS_WINDOW_OPTIONS}
            />
          </Space>
        }
      >
        {series.length > 0 ? (
          <Line data={series.map(p => ({ ts: p.ts, value: p.value }))} xField="ts" yField="value" height={280} loading={loading} />
        ) : (
          <Empty description="窗口内无采样数据(轮询采集约 30s 一次,请稍后)" />
        )}
      </Card>
    </Space>
  )
}

export default function AnalyticsPage() {
  const { me } = useAuth()
  const roles = me?.roles ?? []
  const isSys = roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN)
  const isAppAdmin = roles.includes(PLATFORM_ROLE.APP_ADMIN)

  if (!isSys && !isAppAdmin) {
    return <Alert type="warning" showIcon message="无访问权限" description="分析看板仅对管理员开放。" />
  }

  return (
    <Card size="small" title="分析看板" styles={{ body: { paddingTop: 8 } }}>
      <Tabs
        defaultActiveKey="business"
        items={[
          { key: 'business', label: '业务分析', children: <BusinessTab /> },
          ...(isSys ? [{ key: 'ops', label: '运维健康', children: <OpsTab /> }] : []),
        ]}
      />
    </Card>
  )
}
