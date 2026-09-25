import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { PendingGate, RequireAuth } from './auth/RequireAuth'
import ConsoleLayout from './layouts/ConsoleLayout'
import AnalyticsPage from './pages/Analytics'
import AppDetailPage from './pages/AppDetail'
import AppsPage from './pages/Apps'
import AuditPage from './pages/Audit'
import Home from './pages/Home'
import InstanceDetailPage from './pages/InstanceDetail'
import InstancesPage from './pages/Instances'
import LoginPage from './pages/Login'
import NotFound from './pages/NotFound'
import OrgUnitsPage from './pages/OrgUnits'
import PendingPage from './pages/Pending'
import RegisterPage from './pages/Register'
import UsersPage from './pages/Users'
import WorkflowDetailPage from './pages/WorkflowDetail'
import WorkflowsPage from './pages/Workflows'

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#4d5cf5',
          colorInfo: '#4d5cf5',
          colorLink: '#4d5cf5',
          borderRadius: 10,
          fontFamily:
            "'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          colorBgLayout: '#f2f4fb',
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route
                path="/pending"
                element={
                  <PendingGate>
                    <PendingPage />
                  </PendingGate>
                }
              />
              <Route
                path="/"
                element={
                  <RequireAuth>
                    <ConsoleLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Home />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="org-units" element={<OrgUnitsPage />} />
                <Route path="apps" element={<AppsPage />} />
                <Route path="apps/:appId" element={<AppDetailPage />} />
                <Route path="workflows" element={<WorkflowsPage />} />
                <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
                <Route path="instances" element={<InstancesPage />} />
                <Route path="instances/:instanceId" element={<InstanceDetailPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  )
}
