import { Card, Col, Row, Statistic, Typography } from 'antd'
import { useAuth } from '../auth/AuthContext'
import { PLATFORM_ROLE } from '../api/types'

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
  const accessibleModules = isSys ? 6 : isAppAdmin ? 4 : 1

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
        <Typography.Paragraph>
          使用左侧菜单开始管理:
        </Typography.Paragraph>
        <ul>
          {(isSys || isAppAdmin) && (
            <>
              <li><strong>应用管理</strong>:创建应用、管理角色与成员绑定关系。</li>
              <li><strong>流程定义</strong>:编辑 BPMN XML，校验后发布到 Flowable 引擎。</li>
              <li><strong>流程实例</strong>:发起实例、查看运行中任务、终止实例、完成任务。</li>
            </>
          )}
          {isSys && (
            <>
              <li><strong>平台用户</strong>:审批注册用户、分配系统管理员或应用管理员角色。</li>
              <li><strong>审计</strong>:查所有治理动作的审计事件。</li>
            </>
          )}
          {!(isSys || isAppAdmin) && (
            <li>普通用户暂无 Web Console 管理权限。</li>
          )}
        </ul>
      </Card>
    </div>
  )
}
