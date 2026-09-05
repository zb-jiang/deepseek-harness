import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import css from './EnterpriseUi.module.css'

type PlatformUserStatus = 'pending_approval' | 'active' | 'disabled' | 'locked'

type PlatformUserRow = {
  id: string
  authSubject: string
  loginName: string
  displayName: string
  email: string
  status: PlatformUserStatus
  platformRoles: string[]
}

// ── Supabase client (lazy, cached) ──

let supabaseClient: SupabaseClient | null = null
let supabaseInitPromise: Promise<SupabaseClient> | null = null

function getSupabaseClient(): Promise<SupabaseClient> {
  if (supabaseClient !== null) return Promise.resolve(supabaseClient)
  if (supabaseInitPromise !== null) return supabaseInitPromise
  supabaseInitPromise = (async () => {
    const res = await fetch('/api/enterprise/auth/config')
    const config = await res.json() as { url: string; anonKey: string }
    supabaseClient = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    return supabaseClient
  })()
  return supabaseInitPromise
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

export function useAuth() {
  const snapshot = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)

  useEffect(() => { void initAuth() }, [])

  const login = useCallback(async (email: string, password: string) => {
    const client = await getSupabaseClient()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error !== null) throw new Error(error.message)
    const accessToken = data.session?.access_token
    if (accessToken === undefined) throw new Error('登录失败：未返回会话')
    writeToken(accessToken)
    const user = await fetchJson<PlatformUserRow>('/api/enterprise/auth/me')
    setAuthSnapshot({ currentUser: user, loading: false })
  }, [])

  const register = useCallback(async (email: string, password: string, loginName: string, displayName: string) => {
    const client = await getSupabaseClient()
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { login_name: loginName, display_name: displayName } },
    })
    if (error !== null) throw new Error(error.message)
    // If session is returned (email confirmation disabled), auto-login
    if (data.session?.access_token !== undefined) {
      writeToken(data.session.access_token)
      const user = await fetchJson<PlatformUserRow>('/api/enterprise/auth/me')
      setAuthSnapshot({ currentUser: user, loading: false })
    } else {
      // No session - show login prompt
      throw new Error('注册成功，请使用新账号登录')
    }
  }, [])

  const switchAccount = useCallback(async () => {
    try {
      const client = await getSupabaseClient()
      await client.auth.signOut()
    } catch { /* ignore signout errors */ }
    clearToken()
    setAuthSnapshot({ currentUser: null, loading: false })
  }, [])

  return { ...snapshot, login, register, switchAccount }
}

// ── Auth panel (login / register card) ──

/** 邮箱输入的行首图标。 */
const MailIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
    <path d="m3.5 6 5.8 4.4a2 2 0 0 0 2.4 0L17.5 6" />
  </svg>
)

/** 密码输入的行首图标。 */
const LockIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
    <path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7" />
  </svg>
)

/** 用户名输入的行首图标。 */
const UserIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <circle cx="10" cy="6.5" r="2.8" />
    <path d="M4.5 16.5c.9-2.6 3-4 5.5-4s4.6 1.4 5.5 4" />
  </svg>
)

/** 密码可见性切换按钮的图标。 */
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    {off
      ? <path d="M3.5 10s2.7-4.5 6.5-4.5c1 0 1.9.2 2.7.6M16.5 10s-.5.9-1.4 1.8c-1.3 1.4-2.8 2.2-4.6 2.2-1 0-1.9-.2-2.7-.6M3 3l14 14" />
      : <path d="M2.5 10S5.2 5.5 10 5.5 17.5 10 17.5 10 14.8 14.5 10 14.5 2.5 10 2.5 10Z" />}
    {!off && <circle cx="10" cy="10" r="2.2" />}
  </svg>
)

/** 错误提示的图标。 */
const AlertIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M10 6.5v4.2" strokeLinecap="round" />
    <circle cx="10" cy="13.4" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

/** hero 功能要点勾选图标。 */
const CheckIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="m4 10.5 4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 带行首图标与可选行尾动作的输入框行。 */
function Field({
  icon, type = 'text', placeholder, value, onChange, trailing, autoComplete, autoFocus,
}: {
  icon: ReactNode
  type?: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  trailing?: ReactNode
  autoComplete?: string
  autoFocus?: boolean
}) {
  return (
    <div className={css.field}>
      <span className={css.fieldIcon}>{icon}</span>
      <input
        className={css.fieldInput}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value) }}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      {trailing !== undefined && <span className={css.fieldTrailing}>{trailing}</span>}
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
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loginName, setLoginName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const registerBlocked = loginName.trim() === '' || displayName.trim() === '' || email.trim() === '' || password.trim() === '' || confirmPassword.trim() === ''
  const loginBlocked = email.trim() === '' || password.trim() === ''

  const submit = useCallback(async () => {
    if (mode === 'login' && loginBlocked) return
    if (mode === 'register' && registerBlocked) {
      setError('登录名、显示名、邮箱、密码和确认密码都必须填写')
      return
    }
    if (mode === 'register' && password.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (mode === 'login') {
        await onLogin(email, password)
      } else {
        await onRegister(email, password, loginName, displayName)
        setConfirmPassword('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode, email, password, confirmPassword, loginName, displayName, onLogin, onRegister, loginBlocked, registerBlocked])

  const passwordToggle = (
    <button
      type="button"
      className={css.eyeButton}
      onClick={() => { setShowPassword(v => !v) }}
      aria-label={showPassword ? '隐藏密码' : '显示密码'}
    >
      <EyeIcon off={!showPassword} />
    </button>
  )
  const confirmToggle = (
    <button
      type="button"
      className={css.eyeButton}
      onClick={() => { setShowConfirm(v => !v) }}
      aria-label={showConfirm ? '隐藏密码' : '显示密码'}
    >
      <EyeIcon off={!showConfirm} />
    </button>
  )

  return (
    <div className={css.authPanel}>
      <div className={css.authTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          className={clsx(css.authTab, mode === 'login' && css.authTabActive)}
          onClick={() => { setMode('login'); setError(null) }}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          className={clsx(css.authTab, mode === 'register' && css.authTabActive)}
          onClick={() => { setMode('register'); setError(null) }}
        >
          注册
        </button>
      </div>
      <form
        className={css.authForm}
        onSubmit={(e) => { e.preventDefault(); void submit() }}
      >
        {mode === 'register' && (
          <>
            <Field icon={<UserIcon />} placeholder="登录名" value={loginName} onChange={setLoginName} autoComplete="username" />
            <Field icon={<UserIcon />} placeholder="显示名" value={displayName} onChange={setDisplayName} />
          </>
        )}
        <Field icon={<MailIcon />} type="email" placeholder="邮箱" value={email} onChange={setEmail} autoComplete="email" autoFocus />
        <Field
          icon={<LockIcon />}
          type={showPassword ? 'text' : 'password'}
          placeholder="密码"
          value={password}
          onChange={setPassword}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          trailing={passwordToggle}
        />
        {mode === 'register' && (
          <Field
            icon={<LockIcon />}
            type={showConfirm ? 'text' : 'password'}
            placeholder="确认密码"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            trailing={confirmToggle}
          />
        )}
        {error !== null && (
          <div className={css.authError} role="alert">
            <AlertIcon />
            <span>{error}</span>
          </div>
        )}
        <button
          type="submit"
          className={css.authSubmitButton}
          disabled={loading || (mode === 'login' ? loginBlocked : registerBlocked)}
        >
          {loading && <span className={css.spinner} aria-hidden />}
          {loading ? '请稍候…' : (mode === 'login' ? '登 录' : '注 册')}
        </button>
      </form>
      {mode === 'register' && <div className={css.hint}>注册后需要管理员审批才能进入平台</div>}
    </div>
  )
}

// ── Overlay (right panel) ──

export function EnterpriseOverlay() {
  const { currentUser, loading, login, register, switchAccount } = useAuth()

  const authState = useMemo<'loading' | 'anonymous' | 'pending' | 'blocked' | 'active'>(() => {
    if (loading) return 'loading'
    if (currentUser === null) return 'anonymous'
    if (currentUser.status === 'pending_approval') return 'pending'
    if (currentUser.status === 'disabled' || currentUser.status === 'locked') return 'blocked'
    return 'active'
  }, [currentUser, loading])

  if (authState === 'active') return null

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
            统一身份入口，注册后进入待审批状态，通过后才能进入企业主界面。
          </div>
          <ul className={css.authFeatures}>
            <li><CheckIcon />待办任务一站式处理</li>
            <li><CheckIcon />AI 会话辅助完成任务</li>
            <li><CheckIcon />流程进度与变量全程可视</li>
          </ul>
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
          {(authState === 'pending' || authState === 'blocked') && (
            <div className={css.authBlockedActions}>
              <button
                type="button"
                className={css.authSecondaryButton}
                onClick={() => { void switchAccount() }}
              >
                切换账号
              </button>
              <div className={css.hint}>
                点击后会退出当前账号，返回登录页，以便使用其他账号登录。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
