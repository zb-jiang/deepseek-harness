import { App, Card, DatePicker, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  llmApi,
  type UsageDailyTotal,
  type UsageLedgerEntry,
  type UsageSummaryRow,
} from '../api/llm'

const DIMENSION_OPTIONS = [
  { label: '按人员', value: 'user' },
  { label: '按部门', value: 'org_unit' },
  { label: '按模型', value: 'model' },
]

const LEDGER_STATUS: Record<string, { text: string; color: string }> = {
  completed: { text: '已完成', color: 'green' },
  blocked: { text: '已拦截', color: 'red' },
  failed: { text: '失败', color: 'volcano' },
  cancelled: { text: '已取消', color: 'default' },
}

/** GitHub 贡献图色阶(无消耗 → 最深) */
const HEAT_COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']

/** 按当日 token 量占年度峰值的比例取色阶档位(0 无消耗 → 4 最高档) */
function heatLevel(totalTokens: number, maxTokens: number): number {
  if (totalTokens <= 0 || maxTokens <= 0) return 0
  const ratio = totalTokens / maxTokens
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** 格子边长与间距(px);月份标签按 列序号 × 列距 绝对定位对齐格子 */
const CELL = 12
const GAP = 3
const PITCH = CELL + GAP
/** 左侧行标列宽(px) */
const LABEL_W = 20

interface YearHeatCell {
  key: string
  date: Dayjs
  future: boolean
  level: number
  tokens: number
  requests: number
}

/** GitHub 风格年度消耗热力图:列=周、行=星期(周一开始),月份标签按列对齐,Less→More 取色。 */
function YearHeatmap({ daily }: { daily: UsageDailyTotal[] }) {
  const { byDate, maxTokens } = useMemo(() => {
    const map = new Map<string, UsageDailyTotal>()
    let max = 0
    for (const d of daily) {
      map.set(d.date, d)
      if (d.totalTokens > max) max = d.totalTokens
    }
    return { byDate: map, maxTokens: max }
  }, [daily])

  // 终点今天;起点对齐到 365 天前所在周的周一,末尾不满一周留空
  const today = useMemo(() => dayjs(), [])
  const weeks = useMemo(() => {
    let start = today.subtract(1, 'year')
    start = start.subtract((start.day() + 6) % 7, 'day')
    const weekCount = Math.floor(today.diff(start, 'day') / 7) + 1
    const list: { key: string; cells: YearHeatCell[] }[] = []
    for (let w = 0; w < weekCount; w++) {
      const weekStart = start.add(w * 7, 'day')
      const cells: YearHeatCell[] = []
      for (let i = 0; i < 7; i++) {
        const date = weekStart.add(i, 'day')
        const key = date.format('YYYY-MM-DD')
        const hit = byDate.get(key)
        cells.push({
          key,
          date,
          future: date.isAfter(today, 'day'),
          level: heatLevel(hit?.totalTokens ?? 0, maxTokens),
          tokens: hit?.totalTokens ?? 0,
          requests: hit?.requestCount ?? 0,
        })
      }
      list.push({ key: weekStart.format('YYYY-MM-DD'), cells })
    }
    return list
  }, [today, byDate, maxTokens])

  // 月份标签:每周首日进入新月时在该列位置标注一次
  const monthLabels = useMemo(() => {
    const labels: { key: string; weekIndex: number; text: string }[] = []
    let prevMonth = -1
    weeks.forEach((week, w) => {
      const m = week.cells[0].date.month()
      if (m !== prevMonth) {
        labels.push({ key: week.key, weekIndex: w, text: `${m + 1}月` })
        prevMonth = m
      }
    })
    return labels
  }, [weeks])

  const weekdayLabels = ['一', '', '三', '', '五', '', '']

  return (
    <div>
      <div style={{ position: 'relative', height: 18, marginLeft: LABEL_W + GAP }}>
        {monthLabels.map(l => (
          <span
            key={l.key}
            style={{ position: 'absolute', left: l.weekIndex * PITCH, fontSize: 11, color: '#8c8c8c' }}
          >
            {l.text}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex' }}>
        <div style={{ width: LABEL_W }}>
          {weekdayLabels.map((t, i) => (
            <div
              key={i}
              style={{ height: CELL, marginBottom: GAP, fontSize: 11, lineHeight: `${CELL}px`, color: '#8c8c8c' }}
            >
              {t}
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'grid',
            gridAutoFlow: 'column',
            gridTemplateRows: `repeat(7, ${CELL}px)`,
            gridAutoColumns: `${CELL}px`,
            gap: GAP,
          }}
        >
          {weeks.flatMap(w =>
            w.cells.map((c) => {
              const cell = (
                <div
                  key={c.key}
                  style={{
                    width: CELL,
                    height: CELL,
                    borderRadius: 2,
                    background: c.future ? '#f5f5f5' : HEAT_COLORS[c.level],
                  }}
                />
              )
              return c.future || c.tokens <= 0 ? cell : (
                <Tooltip
                  key={c.key}
                  title={`${c.key}:${c.tokens.toLocaleString()} token / ${c.requests.toLocaleString()} 次请求`}
                >
                  {cell}
                </Tooltip>
              )
            }),
          )}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 4,
          marginTop: 8,
          fontSize: 12,
          color: '#8c8c8c',
        }}
      >
        Less
        {HEAT_COLORS.map(c => (
          <span key={c} style={{ width: CELL, height: CELL, borderRadius: 2, background: c, display: 'inline-block' }} />
        ))}
        More
      </div>
    </div>
  )
}

export default function LlmUsagePage() {
  const { message } = App.useApp()
  const [month, setMonth] = useState<Dayjs>(dayjs())
  const [dimension, setDimension] = useState<string>('user')
  const [summary, setSummary] = useState<UsageSummaryRow[]>([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [yearHeat, setYearHeat] = useState<UsageDailyTotal[]>([])
  const [yearHeatLoading, setYearHeatLoading] = useState(false)
  const [ledger, setLedger] = useState<UsageLedgerEntry[]>([])
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [ledgerPage, setLedgerPage] = useState(1)
  const [ledgerPageSize, setLedgerPageSize] = useState(20)
  const [ledgerStatus, setLedgerStatus] = useState<string | undefined>()
  const [ledgerLoading, setLedgerLoading] = useState(false)

  const monthStr = month.format('YYYY-MM')

  // ---------- 汇总 ----------

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const rows = await llmApi.usageSummary(dimension, monthStr)
      setSummary((rows ?? []).slice().sort((a, b) => b.totalTokens - a.totalTokens))
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载汇总失败')
    } finally {
      setSummaryLoading(false)
    }
  }, [dimension, monthStr, message])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  // ---------- 热力图(近一年,与维度/月份筛选无关) ----------

  const loadYearHeat = useCallback(async () => {
    setYearHeatLoading(true)
    try {
      setYearHeat((await llmApi.usageHeatmapYear()) ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载热力图失败')
    } finally {
      setYearHeatLoading(false)
    }
  }, [message])

  useEffect(() => {
    void loadYearHeat()
  }, [loadYearHeat])

  // ---------- 账本明细 ----------

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true)
    try {
      const page = await llmApi.usageLedger({
        month: monthStr,
        status: ledgerStatus,
        page: ledgerPage,
        pageSize: ledgerPageSize,
      })
      setLedger(page.items ?? [])
      setLedgerTotal(page.total ?? 0)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载明细失败')
    } finally {
      setLedgerLoading(false)
    }
  }, [monthStr, ledgerStatus, ledgerPage, ledgerPageSize, message])

  useEffect(() => {
    void loadLedger()
  }, [loadLedger])

  const summaryColumns: ColumnsType<UsageSummaryRow> = [
    { title: '对象', dataIndex: 'subjectName', key: 'subjectName' },
    {
      title: '总消耗(token)',
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      align: 'right',
      sorter: (a, b) => a.totalTokens - b.totalTokens,
      defaultSortOrder: 'descend',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '输入(token)',
      dataIndex: 'promptTokens',
      key: 'promptTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '输出(token)',
      dataIndex: 'completionTokens',
      key: 'completionTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '超额(token)',
      dataIndex: 'overageTokens',
      key: 'overageTokens',
      align: 'right',
      render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v.toLocaleString()}</Typography.Text> : '0'),
    },
    {
      title: '请求数',
      dataIndex: 'requestCount',
      key: 'requestCount',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
  ]

  const ledgerColumns: ColumnsType<UsageLedgerEntry> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    { title: '用户', dataIndex: 'userDisplayName', key: 'userDisplayName' },
    { title: '模型', dataIndex: 'modelDisplayName', key: 'modelDisplayName' },
    { title: '扣费来源', dataIndex: 'sourceName', key: 'sourceName' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string) => {
        const meta = LEDGER_STATUS[v]
        return meta ? <Tag color={meta.color}>{meta.text}</Tag> : <Tag>{v}</Tag>
      },
    },
    {
      title: '输入',
      dataIndex: 'promptTokens',
      key: 'promptTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '输出',
      dataIndex: 'completionTokens',
      key: 'completionTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '合计',
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '超额',
      dataIndex: 'overageTokens',
      key: 'overageTokens',
      align: 'right',
      render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v.toLocaleString()}</Typography.Text> : '0'),
    },
    {
      title: '错误信息',
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
  ]

  const handleLedgerTableChange = (pagination: TablePaginationConfig) => {
    setLedgerPage(pagination.current ?? 1)
    setLedgerPageSize(pagination.pageSize ?? 20)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>用量分析</Typography.Title>
        <DatePicker.MonthPicker
          value={month}
          onChange={v => setMonth(v ?? dayjs())}
          allowClear={false}
        />
        <Segmented options={DIMENSION_OPTIONS} value={dimension} onChange={v => setDimension(v as string)} />
      </Space>
      <Card title="维度汇总" style={{ marginBottom: 16 }}>
        <Table<UsageSummaryRow>
          rowKey={r => `${r.subjectId}`}
          columns={summaryColumns}
          dataSource={summary}
          loading={summaryLoading}
          pagination={false}
        />
      </Card>
      <Card title="近一年消耗热力图" style={{ marginBottom: 16 }} loading={yearHeatLoading}>
        <YearHeatmap daily={yearHeat} />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          颜色深浅对应当日全对象 token 消耗合计占近一年峰值的比例;悬浮查看当天消耗与请求数。
        </Typography.Paragraph>
      </Card>
      <Card
        title="调用明细"
        extra={
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 140 }}
            value={ledgerStatus}
            onChange={(v) => {
              setLedgerStatus(v)
              setLedgerPage(1)
            }}
            options={Object.entries(LEDGER_STATUS).map(([k, v]) => ({ label: v.text, value: k }))}
          />
        }
      >
        <Table<UsageLedgerEntry>
          rowKey="id"
          columns={ledgerColumns}
          dataSource={ledger}
          loading={ledgerLoading}
          pagination={{
            current: ledgerPage,
            pageSize: ledgerPageSize,
            total: ledgerTotal,
            showSizeChanger: true,
            showTotal: t => `共 ${t.toLocaleString()} 条`,
          }}
          onChange={handleLedgerTableChange}
        />
      </Card>
    </div>
  )
}
