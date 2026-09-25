import {
  ApartmentOutlined, AuditOutlined, BarChartOutlined, ClockCircleOutlined, ClusterOutlined,
  PartitionOutlined, TeamOutlined,
} from '@ant-design/icons'
import { Card, Col, Row, Statistic, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'

/**
 * 菜单功能导览:与 ConsoleLayout 的 buildMenu 同序、同角色条件、同图标
 * (首页自身除外——导览卡片就在首页)。侧栏菜单增删或调整顺序时同步维护本表。
 */
const MENU_GUIDES: readonly { icon: ReactNode; label: string; desc: string; role: 'all' | 'admin' | 'sys' }[] = [
  {
    icon: <ClusterOutlined />,
    label: '部门管理',
    desc: '维护公司的部门架构,查看各部门的成员归属;全员可查,调整仅系统管理员可操作。',
    role: 'all',
  },
  {
    icon: <TeamOutlined />,
    label: '用户管理',
    desc: '审批新同事的注册申请,为他们分配平台管理角色。',
    role: 'sys',
  },
  {
    icon: <ApartmentOutlined />,
    label: '应用管理',
    desc: '创建业务应用,为每个应用配置办理角色和成员。',
    role: 'admin',
  },
  {
    icon: <PartitionOutlined />,
    label: '流程定义',
    desc: '绘制审批流程图,指定每个环节由哪个角色办理,发布后即可投入使用。',
    role: 'admin',
  },
  {
    icon: <ClockCircleOutlined />,
    label: '流程实例',
    desc: '跟踪每笔流程的进度:发起新流程、处理待办、查看进展到哪个环节,必要时终止流程。',
    role: 'all',
  },
  {
    icon: <BarChartOutlined />,
    label: '分析看板',
    desc: '用图表掌握流程运行情况:办理量、办理时效、哪些环节最耗时。',
    role: 'admin',
  },
  {
    icon: <AuditOutlined />,
    label: '审计',
    desc: '留存平台上的关键操作记录,随时可查"谁在什么时间做了什么"。',
    role: 'sys',
  },
]

export default function HomePage() {
  const { me } = useAuth()
  const roles = me?.roles ?? []
  const isSys = roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN)
  const isAppAdmin = roles.includes(PLATFORM_ROLE.APP_ADMIN)
  const roleLabel = isSys
    ? '系统管理员'
    : isAppAdmin
      ? '应用管理员'
      : '普通用户'
  const guides = MENU_GUIDES.filter(guide =>
    guide.role === 'all' || (guide.role === 'admin' && (isSys || isAppAdmin)) || (guide.role === 'sys' && isSys))
  // 功能模块数 = 左侧菜单数 - 1(首页不计为模块),与导览条目一致
  const accessibleModules = guides.length

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        欢迎,{me?.displayName || me?.loginName || me?.email}
      </Typography.Title>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="当前角色" value={roleLabel} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="可访问模块" value={accessibleModules} suffix="个" />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="登录邮箱" value={me?.email ?? '-'} />
          </Card>
        </Col>
      </Row>
      <Card style={{ marginTop: 16 }}>
        <Typography.Paragraph style={{ marginBottom: 16 }}>
          左侧菜单功能导览:
        </Typography.Paragraph>
        <div className="menu-guide-grid">
          {guides.map(guide => (
            <div key={guide.label} className="menu-guide-item">
              <span className="menu-guide-icon" aria-hidden="true">{guide.icon}</span>
              <div className="menu-guide-text">
                <div className="menu-guide-name">{guide.label}</div>
                <div className="menu-guide-desc">{guide.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
