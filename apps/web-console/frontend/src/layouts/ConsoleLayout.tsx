import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  ClusterOutlined,
  HomeOutlined,
  LogoutOutlined,
  PartitionOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'

const { Header, Sider, Content } = Layout

type MenuItem = Required<MenuProps>['items'][number]

/**
 * 菜单项定义。
 * - system_admin: 全部菜单
 * - app_admin: 首页、应用管理、流程定义、流程实例、部门管理(只读)
 * - normal_user: 首页、流程实例(仅自己发起的)、部门管理(只读)
 */
function buildMenu(roles: string[]): MenuItem[] {
  const isSys = roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN)
  const isAppAdmin = roles.includes(PLATFORM_ROLE.APP_ADMIN)
  const items: MenuItem[] = [
    { key: '/', icon: <HomeOutlined />, label: '首页' },
    { key: '/org-units', icon: <ClusterOutlined />, label: '部门管理' },
    { key: '/instances', icon: <ClockCircleOutlined />, label: '流程实例' },
  ]
  if (isSys || isAppAdmin) {
    items.push({ key: '/apps', icon: <ApartmentOutlined />, label: '应用管理' })
    items.push({ key: '/workflows', icon: <PartitionOutlined />, label: '流程定义' })
    // 分析看板:app_admin 只见业务分析 tab,运维健康 tab 后端 @PreAuthorize 双保险
    items.push({ key: '/analytics', icon: <BarChartOutlined />, label: '分析看板' })
  }
  if (isSys) {
    items.push({ key: '/users', icon: <TeamOutlined />, label: '平台用户' })
    items.push({ key: '/audit', icon: <AuditOutlined />, label: '审计' })
  }
  return items
}

export default function ConsoleLayout() {
  const { me, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const roles = me?.roles ?? []
  const items = useMemo(() => buildMenu(roles), [roles])

  const selectedKey = useMemo(() => {
    // 顶级路径前缀匹配(/apps/xxx → /apps)
    const parts = location.pathname.split('/')
    return '/' + (parts[1] ?? '')
  }, [location.pathname])

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  const userMenu: MenuProps = {
    items: [
      {
        key: 'signout',
        icon: <LogoutOutlined />,
        label: '退出登录',
        onClick: () => handleSignOut(),
      },
    ],
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={220} className="dsh-sider" style={{ overflow: 'auto', height: '100vh', position: 'sticky', top: 0 }}>
        <div className="dsh-brand">
          <span className="dsh-brand-logo">DS</span>
          <span>DSH Web Console</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Header className="dsh-header">
          <Dropdown menu={userMenu} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} />
              <span>{me?.displayName || me?.loginName || me?.email || '用户'}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ({roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN)
                  ? '系统管理员'
                  : roles.includes(PLATFORM_ROLE.APP_ADMIN)
                    ? '应用管理员'
                    : '普通用户'})
              </Typography.Text>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
