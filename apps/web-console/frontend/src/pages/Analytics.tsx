/**
 * 分析看板(设计 2026-09-25):业务分析 + 运维健康两个 tab。
 *
 * - 业务分析(system_admin + app_admin):概览卡/每日流程数量/办理人耗时/节点热力图,
 *   数据经 web-console 代理引擎 /dsh/analytics/*;
 *   system_admin 看全局,app_admin 后端收敛到名下应用的已发布流程(下拉同样只列名下流程);
 * - 运维健康(仅 system_admin):引擎指标实时卡 + 趋势折线,
 *   数据为 web-console 轮询落库的 dsh_metrics_sample。
 * 前端按角色显隐 tab;后端 @PreAuthorize + 数据范围收敛双保险(越权直接 403/404)。
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
  Tooltip,
  Typography,
} from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
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

/** 每日流程数量折线数据(双序列拉平为长表;序列名与概览卡名称一致)。 */
function toVolumeSeries(volumes: DailyVolume[]) {
  return volumes.flatMap(v => [
    { date: v.date, value: v.started, type: '发起流程' },
    { date: v.date, value: v.completed, type: '正常完成' },
  ])
}

/** 卡片标题 + 悬浮解释(把统计口径写成业务语言)。 */
function TitleWithHint({ title, hint }: { title: string; hint: string }) {
  return (
    <Space size={4}>
      {title}
      <Tooltip title={hint}>
        <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
      </Tooltip>
    </Space>
  )
}

/** 数值 + 单位的 Statistic 属性;无数据('-')时不显示单位。 */
function unitStat(value: number | string, unit: string): { value: number | string; suffix?: string } {
  return value === '-' ? { value } : { value, suffix: unit }
}

function BusinessTab() {
  const { me } = useAuth()
  const restrictedToManagedApps = !(me?.roles ?? []).includes(PLATFORM_ROLE.SYSTEM_ADMIN)
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
      // app_admin 名下无已发布流程时后端短路返回 null → 归一为空数组
      setOverview(ov)
      setVolumes(dv ?? [])
      setTaskStats(ts ?? [])
      setActivityStats(as ?? [])
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
        <Typography.Text type="secondary">
          统计窗口按发起时间截取
          {restrictedToManagedApps && ' · 仅统计名下应用的流程数据'}
        </Typography.Text>
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <Row gutter={16}>
        <Col span={4}><Card size="small"><Statistic title="发起流程" value={overview?.started ?? 0} suffix="个" /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="正常完成" value={overview?.completed ?? 0} suffix="个" /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="运行中" value={overview?.running ?? 0} suffix="个" /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已终止" value={overview?.terminated ?? 0} suffix="个" /></Card></Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="平均完成耗时" hint="流程从发起到正常完成平均花费的时间(只统计已完成的流程)" />}
              value={formatMs(overview?.avgDurationMs ?? null)}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="95%流程的完成耗时" hint="把窗口内正常完成的流程按耗时从快到慢排队,95%的流程都在这个时间内完成;它代表比较慢的那部分流程的耗时水平" />}
              value={formatMs(overview?.p95DurationMs ?? null)}
            />
          </Card>
        </Col>
      </Row>
      <Card size="small" title="每日流程数量">
        {volumes.length > 0 ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              每天新发起和正常完成的流程个数(条数即流程个数)。
            </Typography.Paragraph>
            <Line
              data={toVolumeSeries(volumes)}
              xField="date"
              yField="value"
              colorField="type"
              legend={{ color: { position: 'top' } }}
              axis={{ y: { labelFormatter: (v: number) => `${v} 个` } }}
              height={260}
              smooth
            />
          </>
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
          <Card size="small" title="办理人耗时榜(完成任务数 Top 50)">
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
                { title: '完成任务数(个)', dataIndex: 'count', width: 120 },
                {
                  title: '平均耗时',
                  dataIndex: 'avgDurationMs',
                  width: 110,
                  render: v => formatMs(v),
                },
                {
                  title: '最长耗时',
                  dataIndex: 'maxDurationMs',
                  width: 110,
                  render: v => formatMs(v),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="最慢节点 Top 10(按平均耗时)">
            <Table<ActivityStat>
              size="small"
              rowKey="activityId"
              dataSource={topSlowNodes}
              loading={loading}
              pagination={false}
              columns={[
                { title: '节点', dataIndex: 'activityName', render: (v, r) => v ?? r.activityId },
                { title: '类型', dataIndex: 'activityType', width: 110 },
                { title: '执行次数(次)', dataIndex: 'count', width: 110 },
                {
                  title: '平均耗时',
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
  { value: 'dsh.flowable.jobs.async', label: '待执行的后台作业数(个)' },
  { value: 'dsh.flowable.jobs.timer', label: '待触发的定时作业数(个)' },
  { value: 'dsh.flowable.jobs.deadletter', label: '执行失败的后台作业数(个)' },
  { value: 'dsh.flowable.jobs.suspended', label: '已挂起的后台作业数(个)' },
  { value: 'hikaricp.connections.active', label: '数据库活跃连接数(个)' },
  { value: 'jvm.memory.used', label: '服务内存占用(MB)' },
  { value: 'dsh.task.escalation', label: '超时自动升级次数(累计,次)' },
  { value: BACKEND_TASK_SUCCESS, label: '自动节点任务成功数(累计,次)' },
  { value: BACKEND_TASK_FAILED, label: '自动节点任务失败数(累计,次)' },
]

/**
 * 趋势图纵轴的业务化展示(一次画一条指标曲线):
 * jvm.memory.used 落库为字节,换算成 MB;COUNT 类指标是次数,其余是个数。
 */
function opsMetricDisplay(metric: string): { toDisplay: (v: number) => number; tick: (v: number) => string } {
  if (metric === 'jvm.memory.used') {
    return {
      toDisplay: v => v / 1024 / 1024,
      tick: v => `${v < 10 ? v.toFixed(1) : Math.round(v)} MB`,
    }
  }
  if (metric.includes('dsh.backend.task') || metric === 'dsh.task.escalation') {
    return { toDisplay: v => v, tick: v => `${v} 次` }
  }
  return { toDisplay: v => v, tick: v => `${v} 个` }
}

function OpsTab() {
  const [summary, setSummary] = useState<OpsSummary | null>(null)
  const [metric, setMetric] = useState(OPS_SERIES_METRICS[0].value)
  const [windowHours, setWindowHours] = useState(6)
  const [series, setSeries] = useState<SeriesPoint[]>([])
  // 两个请求的错误分开记录:早期共用一个 state,序列加载成功会清掉汇总的错误,
  // 汇总 30s 轮询失败又设回来,表现为错误提示"时有时无"
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await analyticsApi.opsSummary())
      setSummaryError(null)
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : '运维汇总加载失败')
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
      setSeriesError(null)
    } catch (e) {
      setSeriesError(e instanceof Error ? e.message : '指标序列加载失败')
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
  // 趋势图取值换算与纵轴单位随所选指标变化
  const display = opsMetricDisplay(metric)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {summaryError && <Alert type="error" showIcon message={summaryError} />}
      <Row gutter={16}>
        <Col span={3}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="待执行作业" hint="流程引擎排队等待执行的后台作业数量" />}
              {...unitStat(jobValue('dsh.flowable.jobs.async'), '个')}
            />
          </Card>
        </Col>
        <Col span={3}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="定时作业" hint="等待到达设定时间再执行的后台作业(如定时器、节点超时检查)" />}
              {...unitStat(jobValue('dsh.flowable.jobs.timer'), '个')}
            />
          </Card>
        </Col>
        <Col span={3}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="失败作业" hint="自动重试多次仍然失败、需要管理员处理的后台作业(即 dead-letter job)" />}
              {...unitStat(jobValue('dsh.flowable.jobs.deadletter'), '个')}
            />
          </Card>
        </Col>
        <Col span={3}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="挂起作业" hint="被暂停、暂不执行的后台作业数量" />}
              {...unitStat(jobValue('dsh.flowable.jobs.suspended'), '个')}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="自动节点成功率(近1小时)" hint="服务器端自动运行的 AI 节点任务(DSH backend task)近 1 小时的成功率" />}
              value={summary?.backendTaskSuccessRate != null
                ? `${(summary.backendTaskSuccessRate * 100).toFixed(1)}%`
                : '-'}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="自动节点平均耗时(近1小时)" hint="服务器端自动运行的 AI 节点任务近 1 小时的平均处理时长" />}
              value={formatMs(summary?.backendTaskAvgLatencyMs ?? null)}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<TitleWithHint title="超时自动升级(近1小时)" hint="任务在规定时间内没办完,按超时策略自动转交给其他人处理的次数" />}
              {...unitStat(summary?.escalationCount1h ?? '-', '次')}
            />
          </Card>
        </Col>
      </Row>
      {seriesError && <Alert type="error" showIcon message={seriesError} />}
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
          <Line
            data={series.map(p => ({ ts: p.ts, value: display.toDisplay(p.value) }))}
            xField="ts"
            yField="value"
            axis={{ y: { labelFormatter: display.tick } }}
            height={280}
            loading={loading}
          />
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
