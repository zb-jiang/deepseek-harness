import { LockOutlined, MailOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/Brand'

interface LoginForm {
  email: string
  password: string
}

export default function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    setError(null)
    try {
      await signIn(values.email, values.password)
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
      navigate(from, { replace: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '登录失败'
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-shell">
      <Card style={{ width: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandMark variant="auth" />
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            云汉企业AI协同平台
          </Typography.Title>
          <Typography.Text type="secondary">企业级应用平台管理后台</Typography.Text>
        </div>
        {error && (
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        <Form<LoginForm> layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
          >
            <Input prefix={<MailOutlined />} placeholder="you@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          登录账号由 Supabase Auth 管理;首次注册后需平台管理员审批方可使用后台。
        </Typography.Paragraph>
        <div style={{ textAlign: 'center' }}>
          还没账号? <Link to="/register">立即注册</Link>
        </div>
      </Card>
    </div>
  )
}
