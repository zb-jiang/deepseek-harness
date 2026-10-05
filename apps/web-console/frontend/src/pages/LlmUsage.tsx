import { ReloadOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'
import {
  llmApi,
  type UsageDailyTotal,
  type UsageLedgerEntry,
  type UsageLedgerFilterOptions,
  type UsageSummaryRow,
} from '../api/llm'

/** 维度口径枚举,与后端 LlmLedgerJdbcRepository.summary 一致 */
type Dimension = 'user' | 'pool_user' | 'pool_org_unit' | 'model'

/** 各维度的分组、标签与口径说明(员工×部门为多对多,不提供部门员工合计口径) */
const DIMENSION_META: Record<Dimension, { label: string; group: string; caption: string }> = {
  user: {
    label: '人员',
    group: '谁在用',
    caption: '按请求发起人统计真实用量——无论从哪个授权池扣费,都算在发起人名下。',
  },
  pool_user: {
    label: '人员池',
    group: '池被消耗',
    caption: '按个人授权池统计实际扣费——含其他用户路由借用的量,不含本人走部门池的量。',
  },
  pool_org_unit: {
    label: '部门池',
    group: '池被消耗',
    caption: '按部门授权池统计实际扣费——含外部借用的量,不含本部门员工走个人池的量。',
  },
  model: {
    label: '模型',
    group: '按模型',
    caption: '按模型统计全部实际扣费的消耗。',
  },
}

const LEDGER_STATUS: Record<string, { text: string; color: string }> = {
  completed: { text: '已完成', color: 'green' },
  reserved: { text: '预留中', color: 'blue' },
  blocked: { text: '已拦截', color: 'red' },
  failed: { text: '失败', color: 'volcano' },
  cancelled: { text: '已取消', color: 'default' },
}

/** 状态筛选的「全部」哨兵值:请求后端时归一为 undefined(不过滤) */
const STATUS_ALL = 'ALL'

/** 时间段快捷项:RangePicker presets;清空区间 = 全部时间(value 显式标为二元组,否则返回值推断为 Dayjs[] 不满足 presets) */
const RANGE_PRESETS: { label: string; value: () => [Dayjs, Dayjs] }[] = [
  { label: '今天', value: () => [dayjs().startOf('day'), dayjs()] },
  { label: '本周', value: () => [dayjs().startOf('week'), dayjs()] },
  { label: '本月', value: () => [dayjs().startOf('month'), dayjs()] },
  { label: '近 7 天', value: () => [dayjs().subtract(6, 'day').startOf('day'), dayjs()] },
  { label: '近 30 天', value: () => [dayjs().subtract(29, 'day').startOf('day'), dayjs()] },
]

/** 扣费来源下拉的分组文案(sourceType → 组名) */
const SOURCE_GROUP: Record<string, string> = {
  org_unit: '部门额度池',
  user: '个人额度池',
}

/** 下拉选项展示名:账本快照/实时名都缺失(写入前已删除)时退化为短 id */
function labelOf(id: string, name: string | null): string {
  return name ?? id.slice(0, 8)
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
  const { me } = useAuth()
  // 维度汇总是全貌数据,仅系统管理员可见/可查;热力图与明细后端按角色自动收敛
  const isSys = me?.roles?.includes(PLATFORM_ROLE.SYSTEM_ADMIN) ?? false
  const [month, setMonth] = useState<Dayjs>(dayjs())
  const [dimension, setDimension] = useState<Dimension>('user')
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
  // 账本筛选:时间区间(默认本月)、模型、扣费来源(type:id 组合键)、用户(仅系统管理员)
  const [ledgerRange, setLedgerRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().startOf('month'),
    dayjs(),
  ])
  const [ledgerModelId, setLedgerModelId] = useState<string | undefined>()
  const [ledgerSource, setLedgerSource] = useState<string | undefined>()
  const [ledgerUserId, setLedgerUserId] = useState<string | undefined>()
  const [filterOptions, setFilterOptions] = useState<UsageLedgerFilterOptions | undefined>()

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
    if (!isSys) return
    void loadSummary()
  }, [loadSummary, isSys])

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

  const loadFilters = useCallback(async () => {
    try {
      setFilterOptions(await llmApi.usageLedgerFilters())
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载筛选选项失败')
    }
  }, [message])

  useEffect(() => {
    void loadFilters()
  }, [loadFilters])

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true)
    try {
      // 区间按整天换算:from=起始日 00:00,to=结束日次日 00:00(排他上界),清空=全部时间
      const from = ledgerRange?.[0].startOf('day').toISOString()
      const to = ledgerRange?.[1].add(1, 'day').startOf('day').toISOString()
      // 扣费来源组合键 "sourceType:sourceId";UUID 不含冒号,按首个冒号拆分安全
      const sep = ledgerSource?.indexOf(':') ?? -1
      const page = await llmApi.usageLedger({
        from,
        to,
        modelId: ledgerModelId,
        sourceType: sep >= 0 ? ledgerSource!.slice(0, sep) : undefined,
        sourceId: sep >= 0 ? ledgerSource!.slice(sep + 1) : undefined,
        userId: isSys ? ledgerUserId : undefined,
        status: ledgerStatus === STATUS_ALL ? undefined : ledgerStatus,
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
  }, [ledgerRange, ledgerModelId, ledgerSource, ledgerUserId, ledgerStatus, ledgerPage,
    ledgerPageSize, isSys, message])

  useEffect(() => {
    void loadLedger()
  }, [loadLedger])

  const summaryColumns: ColumnsType<UsageSummaryRow> = [
    {
      title: { user: '人员', pool_user: '池归属人员', pool_org_unit: '池归属部门', model: '模型' }[dimension],
      dataIndex: 'subjectName',
      key: 'subjectName',
    },
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
      render: (v: string | null) => {
        if (!v) return '-'
        return (
          <Space size={4}>
            <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 280 }}>{v}</Typography.Text>
            <Typography.Text copyable={{ text: v, tooltips: ['复制', '已复制'] }} />
          </Space>
        )
      },
    },
  ]

  // 下拉选项:名称取账本快照优先(实时名兜底),已删除实体仍按历史名出现
  const userOptions = useMemo(
    () => (filterOptions?.users ?? []).map(o => ({ value: o.id, label: labelOf(o.id, o.name) })),
    [filterOptions],
  )
  const modelOptions = useMemo(
    () => (filterOptions?.models ?? []).map(o => ({ value: o.id, label: labelOf(o.id, o.name) })),
    [filterOptions],
  )
  const sourceOptions = useMemo(() => {
    const groups = new Map<string, { value: string; label: string }[]>()
    for (const o of filterOptions?.sources ?? []) {
      const type = o.type ?? 'user'
      const list = groups.get(type) ?? []
      list.push({ value: `${type}:${o.id}`, label: labelOf(o.id, o.name) })
      groups.set(type, list)
    }
    return [...groups.entries()].map(([type, options]) => ({
      label: SOURCE_GROUP[type] ?? type,
      options,
    }))
  }, [filterOptions])

  const handleLedgerTableChange = (pagination: TablePaginationConfig) => {
    setLedgerPage(pagination.current ?? 1)
    setLedgerPageSize(pagination.pageSize ?? 20)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>用量分析</Typography.Title>
        {isSys && (
          <DatePicker.MonthPicker
            value={month}
            onChange={v => setMonth(v ?? dayjs())}
            allowClear={false}
          />
        )}
        {isSys && (
          <Segmented
            options={(Object.keys(DIMENSION_META) as Dimension[]).map(d => ({
              label: DIMENSION_META[d].label,
              value: d,
            }))}
            value={dimension}
            onChange={v => setDimension(v as Dimension)}
          />
        )}
      </Space>
      {isSys && (
        <Card
          title={`维度汇总 · ${DIMENSION_META[dimension].group}（${DIMENSION_META[dimension].label}）`}
          style={{ marginBottom: 16 }}
        >
          <div
            style={{
              borderLeft: '3px solid #91caff',
              paddingLeft: 10,
              marginBottom: 12,
              fontSize: 12,
              color: '#8c8c8c',
            }}
          >
            统计口径:{DIMENSION_META[dimension].caption} 自然月为最小统计粒度。
          </div>
          <Table<UsageSummaryRow>
            rowKey={r => `${r.subjectId}`}
            columns={summaryColumns}
            dataSource={summary}
            loading={summaryLoading}
            pagination={false}
          />
        </Card>
      )}
      <Card title="近一年消耗热力图" style={{ marginBottom: 16 }} loading={yearHeatLoading}>
        <YearHeatmap daily={yearHeat} />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          {isSys
            ? '颜色深浅对应当日全对象 token 消耗合计占近一年峰值的比例;悬浮查看当天消耗与请求数。'
            : '颜色深浅对应当日你本人的 token 消耗占近一年峰值的比例;悬浮查看当天消耗与请求数。'}
        </Typography.Paragraph>
      </Card>
      <Card title="调用明细">
        <Space size={8} wrap style={{ marginBottom: 16 }}>
          <DatePicker.RangePicker
            value={ledgerRange}
            presets={RANGE_PRESETS}
            allowClear
            placeholder={['开始日期', '结束日期']}
            onChange={(v) => {
              setLedgerRange(v && v[0] && v[1] ? [v[0], v[1]] : null)
              setLedgerPage(1)
            }}
          />
          {isSys && (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按用户筛选"
              style={{ width: 140 }}
              value={ledgerUserId}
              onChange={(v) => {
                setLedgerUserId(v)
                setLedgerPage(1)
              }}
              options={userOptions}
            />
          )}
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按模型筛选"
            style={{ width: 160 }}
            value={ledgerModelId}
            onChange={(v) => {
              setLedgerModelId(v)
              setLedgerPage(1)
            }}
            options={modelOptions}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按扣费来源筛选"
            style={{ width: 180 }}
            value={ledgerSource}
            onChange={(v) => {
              setLedgerSource(v)
              setLedgerPage(1)
            }}
            options={sourceOptions}
          />
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 120 }}
            value={ledgerStatus}
            onChange={(v) => {
              setLedgerStatus(v)
              setLedgerPage(1)
            }}
            options={[
              { label: '全部', value: STATUS_ALL },
              ...Object.entries(LEDGER_STATUS).map(([k, v]) => ({ label: v.text, value: k })),
            ]}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={ledgerLoading}
            onClick={() => {
              void loadLedger()
              void loadFilters()
            }}
          />
        </Space>
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
