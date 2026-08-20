import { useCallback, useEffect, useMemo, useSyncExternalStore, useState } from 'react'
import clsx from 'clsx'
import { BrandWordmark, Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './EnterpriseUi.module.css'

type EnterprisePage = 'users' | 'audit'

type PlatformUserStatus = 'pending_approval' | 'active' | 'disabled' | 'locked'
type PlatformRole = 'system_admin' | 'app_admin' | 'normal_user'

type PlatformUserRow = {
  id: string
  authSubject: string
  loginName: string
  displayName: string
  email: string
  status: PlatformUserStatus
  platformRoles: PlatformRole[]
}

type AuditEventRow = {
  id: string
  eventType: string
  targetUserId: string
  operatorId: string | null
  details: Record<string, unknown>
  createdAt: string
}

type RoleDialogState = {
  mode: 'approve' | 'setRoles'
  userId: string
  displayName: string
  selectedRoles: PlatformRole[]
}

type ReasonDialogState = {
  mode: 'disable' | 'lock'
  userId: string
  displayName: string
  reason: string
}

// ── Auth store (module-level, shared across Nav + Overlay) ──

const TOKEN_KEY = 'dsh.enterprise.token'

type AuthSnapshot = { currentUser: PlatformUserRow | null; loading: boolean }

let authSnapshot: AuthSnapshot = { currentUser: null, loading: true }
const authListeners = new Set<() => void>()
let authInitialized = false

function subscribeAuth(fn: () => void): () => void {
  authListeners.add(fn)
  return () => { authListeners.delete(fn) }
}

function getAuthSnapshot(): AuthSnapshot {
  return authSnapshot
}

function setAuthSnapshot(next: AuthSnapshot): void {
  authSnapshot = next
  authListeners.forEach(fn => fn())
}

function readToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY)
}

function writeToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token)
}

function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY)
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const token = readToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(input, { ...init, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json() as Promise<T>
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function labelForUser(userId: string | null, userMap: ReadonlyMap<string, PlatformUserRow>): string {
  if (userId === null) return '-'
  return userMap.get(userId)?.displayName ?? '-'
}

function usePlatformUserDirectory(enabled: boolean) {
  const [rows, setRows] = useState<PlatformUserRow[]>([])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchJson<PlatformUserRow[]>('/api/enterprise/platform-users').then((data) => {
      if (!cancelled) setRows(data)
    }).catch(() => {
      if (!cancelled) setRows([])
    })
    return () => { cancelled = true }
  }, [enabled])

  const userMap = useMemo(
    () => new Map(rows.map(row => [row.id, row])),
    [rows],
  )

  return { rows, userMap }
}

async function initAuth(): Promise<void> {
  if (authInitialized) return
  authInitialized = true
  const token = readToken()
  if (token === null) {
    setAuthSnapshot({ currentUser: null, loading: false })
    return
  }
  try {
    const user = await fetchJson<PlatformUserRow>('/api/enterprise/auth/me')
    setAuthSnapshot({ currentUser: user, loading: false })
  } catch {
    clearToken()
    setAuthSnapshot({ currentUser: null, loading: false })
  }
}

function useAuth() {
  const snapshot = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)

  useEffect(() => { void initAuth() }, [])

  const login = useCallback(async (email: string, password: string) => {
    const result = await fetchJson<{ accessToken: string; platformUser: PlatformUserRow }>(
      '/api/enterprise/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
    )
    writeToken(result.accessToken)
    setAuthSnapshot({ currentUser: result.platformUser, loading: false })
  }, [])

  const register = useCallback(async (email: string, password: string, loginName: string, displayName: string) => {
    await fetchJson('/api/enterprise/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, loginName, displayName }),
    })
    await login(email, password)
  }, [login])

  const logout = useCallback(() => {
    clearToken()
    setAuthSnapshot({ currentUser: null, loading: false })
  }, [])

  return { ...snapshot, login, register, logout }
}

// ── Hash routing ──

const ENTERPRISE_PREFIX = '#/enterprise/'

function parseEnterprisePage(hash: string): EnterprisePage | null {
  if (!hash.startsWith(ENTERPRISE_PREFIX)) return null
  const raw = hash.slice(ENTERPRISE_PREFIX.length).split('?')[0] ?? ''
  if (raw === 'users' || raw === 'audit') return raw
  return 'users'
}

function setEnterprisePage(page: EnterprisePage): void {
  window.location.hash = `${ENTERPRISE_PREFIX}${page}`
}

function clearEnterprisePage(): void {
  if (window.location.hash.startsWith(ENTERPRISE_PREFIX)) window.location.hash = ''
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => { setHash(window.location.hash) }
    window.addEventListener('hashchange', onChange)
    return () => { window.removeEventListener('hashchange', onChange) }
  }, [])
  return hash
}

// ── Nav (sidebar) ──

export function EnterpriseNav({ wide }: { wide: boolean }) {
  const { currentUser, loading, logout } = useAuth()

  if (loading) return null

  if (currentUser === null) return null

  if (currentUser.status === 'pending_approval') {
    return null
  }

  if (currentUser.status === 'disabled' || currentUser.status === 'locked') {
    return null
  }

  const items: { key: EnterprisePage; label: string }[] = [
    { key: 'users', label: '平台用户' },
    { key: 'audit', label: '审计日志' },
  ]

  return (
    <div className={css.nav}>
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          className={clsx(css.navButton, parseEnterprisePage(window.location.hash) === item.key && css.navButtonActive)}
          onClick={() => { setEnterprisePage(item.key) }}
        >
          {wide ? item.label : item.label.slice(0, 1)}
        </button>
      ))}
      <div className={css.navUser}>
        {wide && <span className={css.navUserLabel}>{currentUser.displayName}</span>}
        <button type="button" className={css.logoutButton} onClick={logout}>
          {wide ? '退出' : '×'}
        </button>
      </div>
    </div>
  )
}

function AuthPanel({
  onLogin,
  onRegister,
}: {
  onLogin: (email: string, password: string) => Promise<void>
  onRegister: (email: string, password: string, loginName: string, displayName: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginName, setLoginName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const registerBlocked = loginName.trim() === '' || displayName.trim() === '' || email.trim() === '' || password.trim() === ''
  const loginBlocked = email.trim() === '' || password.trim() === ''

  const submit = useCallback(async () => {
    if (mode === 'login' && loginBlocked) return
    if (mode === 'register' && registerBlocked) {
      setError('登录名、显示名、邮箱和密码都必须填写')
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (mode === 'login') {
        await onLogin(email, password)
      } else {
        await onRegister(email, password, loginName, displayName)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode, email, password, loginName, displayName, onLogin, onRegister, loginBlocked, registerBlocked])

  return (
    <div className={css.authPanel}>
      <div className={css.authTabs}>
        <button type="button" className={clsx(css.authTab, mode === 'login' && css.authTabActive)} onClick={() => { setMode('login') }}>登录</button>
        <button type="button" className={clsx(css.authTab, mode === 'register' && css.authTabActive)} onClick={() => { setMode('register') }}>注册</button>
      </div>
      <div className={css.authForm}>
        {mode === 'register' && (
          <>
            <input className={clsx(css.textInput, css.authTextInput)} placeholder="登录名 *" value={loginName} onChange={(e) => { setLoginName(e.target.value) }} />
            <input className={clsx(css.textInput, css.authTextInput)} placeholder="显示名 *" value={displayName} onChange={(e) => { setDisplayName(e.target.value) }} />
          </>
        )}
        <input className={clsx(css.textInput, css.authTextInput)} placeholder="邮箱 *" value={email} onChange={(e) => { setEmail(e.target.value) }} />
        <input className={clsx(css.textInput, css.authTextInput)} type="password" placeholder="密码 *" value={password} onChange={(e) => { setPassword(e.target.value) }} />
        {error !== null && <div className={css.authError}>{error}</div>}
        <button
          type="button"
          className={clsx(css.actionButton, css.authSubmitButton)}
          onClick={() => { void submit() }}
          disabled={loading || (mode === 'login' ? loginBlocked : registerBlocked)}
        >
          {loading ? '处理中…' : (mode === 'login' ? '登录' : '注册')}
        </button>
      </div>
      {mode === 'register' && <div className={css.hint}>注册后需要管理员审批才能登录</div>}
    </div>
  )
}

// ── Overlay (right panel) ──

export function EnterpriseOverlay() {
  const { currentUser, loading, login, register, logout } = useAuth()
  const hash = useHash()
  const page = parseEnterprisePage(hash)

  const authState = useMemo<'loading' | 'anonymous' | 'pending' | 'blocked' | 'active'>(() => {
    if (loading) return 'loading'
    if (currentUser === null) return 'anonymous'
    if (currentUser.status === 'pending_approval') return 'pending'
    if (currentUser.status === 'disabled' || currentUser.status === 'locked') return 'blocked'
    return 'active'
  }, [currentUser, loading])

  if (authState !== 'active') {
    return (
      <div className={css.authPageRoot}>
        <div className={css.authPageShell}>
          <div className={css.authHero}>
            <div className={css.authBadge}>Enterprise Profile</div>
            <div className={css.authBrand}>
              <BrandWordmark />
            </div>
            <div className={css.authPageTitle}>企业流程协同工作台</div>
            <div className={css.authPageSubtitle}>
              把注册审批、平台治理、流程待办和审计查看收敛到统一入口。
            </div>
            <div className={css.authFeatureList}>
              <div className={css.authFeatureItem}>
                <div className={css.authFeatureTitle}>统一身份入口</div>
                <div className={css.authFeatureText}>注册后进入待审批状态，通过后才能进入企业主界面。</div>
              </div>
              <div className={css.authFeatureItem}>
                <div className={css.authFeatureTitle}>流程驱动工作台</div>
                <div className={css.authFeatureText}>登录后直接进入平台治理与流程协同场景，而不是个人助手场景。</div>
              </div>
            </div>
          </div>
          <div className={css.authPageCard}>
            <div className={css.authPageHeader}>
              <div className={css.authCardTitle}>
                {authState === 'loading' && '检查登录状态'}
                {authState === 'anonymous' && '登录或注册'}
                {authState === 'pending' && '等待审批'}
                {authState === 'blocked' && '账号不可用'}
              </div>
              <div className={css.authCardSubtitle}>
                {authState === 'loading' && '正在确认你的企业身份信息...'}
                {authState === 'anonymous' && '使用企业账号进入当前工作台。'}
                {authState === 'pending' && '你的账号已注册成功，等待系统管理员审批后才能进入平台。'}
                {authState === 'blocked' && `当前账号已${currentUser?.status === 'disabled' ? '禁用' : '锁定'}，请联系管理员处理。`}
              </div>
            </div>
            {authState === 'anonymous' && <AuthPanel onLogin={login} onRegister={register} />}
            {authState === 'blocked' && (
              <div className={css.authBlockedActions}>
                <button
                  type="button"
                  className={clsx(css.actionButton, css.authSecondaryButton)}
                  onClick={logout}
                >
                  切换用户
                </button>
                <div className={css.hint}>
                  点击后会退出当前账号，返回登录页，以便使用其他账号登录并处理解锁。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (page === null) return null
  if (currentUser === null) return null
  const activeUser = currentUser

  const title = page === 'users' ? '平台用户' : '审计日志'

  return (
    <div className={css.overlayRoot}>
      <div className={css.backdrop} onClick={() => { clearEnterprisePage() }} />
      <div className={css.panel}>
        <div className={css.panelHeader}>
          <div className={css.panelTitle}>{title}</div>
          <button type="button" className={css.closeButton} onClick={() => { clearEnterprisePage() }}>关闭</button>
        </div>
        <div className={css.panelBody}>
          {page === 'users' && <PlatformUsersPage operatorId={activeUser.id} />}
          {page === 'audit' && <AuditLogPage />}
        </div>
      </div>
    </div>
  )
}

// ── Platform Users page ──

function PlatformUsersPage({ operatorId }: { operatorId: string }) {
  const [rows, setRows] = useState<PlatformUserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roleDialog, setRoleDialog] = useState<RoleDialogState | null>(null)
  const [reasonDialog, setReasonDialog] = useState<ReasonDialogState | null>(null)
  const [saving, setSaving] = useState(false)
  const operatorRow = useMemo(() => rows.find(row => row.id === operatorId) ?? null, [operatorId, rows])
  const canGovern = operatorRow?.platformRoles.includes('system_admin') ?? false

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchJson<PlatformUserRow[]>('/api/enterprise/platform-users')
      setRows(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const restore = useCallback(async (id: string) => {
    await fetchJson(`/api/enterprise/platform-users/${id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restoredBy: operatorId }),
    })
    await reload()
  }, [operatorId, reload])

  const submitRoles = useCallback(async () => {
    if (roleDialog === null) return
    setSaving(true)
    setError(null)
    try {
      await fetchJson(`/api/enterprise/platform-users/${roleDialog.userId}/${roleDialog.mode === 'approve' ? 'approve' : 'roles'}`, {
        method: roleDialog.mode === 'approve' ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          roleDialog.mode === 'approve'
            ? { approvedBy: operatorId, platformRoles: roleDialog.selectedRoles }
            : { changedBy: operatorId, platformRoles: roleDialog.selectedRoles },
        ),
      })
      await reload()
      setRoleDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [operatorId, reload, roleDialog])

  const submitReason = useCallback(async () => {
    if (reasonDialog === null) return
    setSaving(true)
    setError(null)
    try {
      await fetchJson(`/api/enterprise/platform-users/${reasonDialog.userId}/${reasonDialog.mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(reasonDialog.mode === 'disable' ? { disabledBy: operatorId } : { lockedBy: operatorId }),
          ...(reasonDialog.reason.trim() === '' ? {} : { reason: reasonDialog.reason.trim() }),
        }),
      })
      await reload()
      setReasonDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [operatorId, reasonDialog, reload])

  const toggleRole = useCallback((role: PlatformRole) => {
    setRoleDialog((current) => {
      if (current === null) return current
      const selectedRoles = current.selectedRoles.includes(role)
        ? current.selectedRoles.filter(item => item !== role)
        : [...current.selectedRoles, role]
      return { ...current, selectedRoles }
    })
  }, [])

  return (
    <div>
      <div className={css.actions} style={{ marginBottom: 12 }}>
        <button type="button" className={css.actionButton} onClick={() => { void reload() }}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error !== null && <div className={css.hint}>{error}</div>}
      <table className={css.table}>
        <thead>
          <tr>
            <th>登录名</th>
            <th>显示名</th>
            <th>邮箱</th>
            <th>状态</th>
            <th>角色</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td>{row.loginName}</td>
              <td>{row.displayName}</td>
              <td>{row.email}</td>
              <td>{row.status}</td>
              <td>{row.platformRoles.join(', ')}</td>
              <td>
                <div className={css.actions}>
                  {row.status === 'pending_approval' && (
                    <button
                      type="button"
                      className={css.actionButton}
                      disabled={!canGovern}
                      onClick={() => {
                        setRoleDialog({
                          mode: 'approve',
                          userId: row.id,
                          displayName: row.displayName,
                          selectedRoles: ['normal_user'],
                        })
                      }}
                    >
                      审批
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.actionButton}
                    disabled={!canGovern || row.id === operatorId}
                    onClick={() => {
                      setRoleDialog({
                        mode: 'setRoles',
                        userId: row.id,
                        displayName: row.displayName,
                        selectedRoles: [...row.platformRoles],
                      })
                    }}
                  >
                    改角色
                  </button>
                  {row.status !== 'disabled' && (
                    <button
                      type="button"
                      className={css.actionButton}
                      disabled={!canGovern || row.id === operatorId}
                      onClick={() => {
                        setReasonDialog({
                          mode: 'disable',
                          userId: row.id,
                          displayName: row.displayName,
                          reason: '',
                        })
                      }}
                    >
                      禁用
                    </button>
                  )}
                  {row.status !== 'locked' && (
                    <button
                      type="button"
                      className={css.actionButton}
                      disabled={!canGovern || row.id === operatorId}
                      onClick={() => {
                        setReasonDialog({
                          mode: 'lock',
                          userId: row.id,
                          displayName: row.displayName,
                          reason: '',
                        })
                      }}
                    >
                      锁定
                    </button>
                  )}
                  {(row.status === 'disabled' || row.status === 'locked') && (
                    <button type="button" className={css.actionButton} onClick={() => { void restore(row.id) }}>
                      恢复
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6}>{loading ? '加载中…' : '暂无数据'}</td>
            </tr>
          )}
        </tbody>
      </table>
      {operatorRow !== null && (
        <div className={css.hint}>
          当前登录用户：{operatorRow.displayName}。
          {!canGovern ? ' 只有系统管理员可以执行审批、改角色、禁用、锁定。' : ' 不能禁用、锁定自己，也不能修改自己的平台角色。'}
        </div>
      )}
      <Modal
        open={roleDialog !== null}
        onClose={() => { if (!saving) setRoleDialog(null) }}
        closeLabel="关闭"
        title={roleDialog?.mode === 'approve' ? '审批用户' : '修改平台角色'}
        {...(roleDialog === null
          ? {}
          : {
            description: roleDialog.mode === 'approve'
              ? `为 ${roleDialog.displayName} 选择审批通过后的平台角色`
              : `为 ${roleDialog.displayName} 选择平台角色`,
          })}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={() => { setRoleDialog(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={saving || roleDialog === null || roleDialog.selectedRoles.length === 0}
              onClick={() => { void submitRoles() }}
            >
              确定
            </Button>
          </>
        )}
      >
        <div className={css.dialogBody}>
          {(['system_admin', 'app_admin', 'normal_user'] as const).map(role => (
            <label key={role} className={css.roleOption}>
              <input
                type="checkbox"
                checked={roleDialog?.selectedRoles.includes(role) ?? false}
                onChange={() => { toggleRole(role) }}
              />
              <span>{role}</span>
            </label>
          ))}
        </div>
      </Modal>
      <Modal
        open={reasonDialog !== null}
        onClose={() => { if (!saving) setReasonDialog(null) }}
        closeLabel="关闭"
        title={reasonDialog?.mode === 'disable' ? '禁用用户' : '锁定用户'}
        {...(reasonDialog === null ? {} : { description: `${reasonDialog.mode === 'disable' ? '禁用' : '锁定'} ${reasonDialog.displayName} 前，请填写原因` })}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={() => { setReasonDialog(null) }}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => { void submitReason() }}>确认</Button>
          </>
        )}
      >
        <div className={css.dialogBody}>
          <input
            className={css.textInput}
            placeholder={reasonDialog?.mode === 'disable' ? '请输入禁用原因' : '请输入锁定原因'}
            value={reasonDialog?.reason ?? ''}
            onChange={(e) => {
              setReasonDialog(current => current === null ? current : { ...current, reason: e.target.value })
            }}
          />
        </div>
      </Modal>
    </div>
  )
}

// ── Audit Log page ──

function AuditLogPage() {
  const [events, setEvents] = useState<AuditEventRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { userMap } = usePlatformUserDirectory(true)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchJson<AuditEventRow[]>('/api/enterprise/audit-events?limit=50')
      setEvents(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  return (
    <div>
      <div className={css.actions} style={{ marginBottom: 12 }}>
        <button type="button" className={css.actionButton} onClick={() => { void reload() }}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error !== null && <div className={css.hint}>{error}</div>}
      <table className={css.table}>
        <thead>
          <tr>
            <th>时间</th>
            <th>事件类型</th>
            <th>目标用户</th>
            <th>操作人</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => (
            <tr key={e.id}>
              <td>{formatTimestamp(e.createdAt)}</td>
              <td>{e.eventType}</td>
              <td>{labelForUser(e.targetUserId, userMap)}</td>
              <td>{labelForUser(e.operatorId, userMap)}</td>
              <td>{JSON.stringify(e.details)}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={5}>{loading ? '加载中…' : '暂无数据'}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
