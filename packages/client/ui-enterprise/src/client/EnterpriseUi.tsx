import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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

  return (
    <div className={css.authPanel}>
      <div className={css.authTabs}>
        <button type="button" className={clsx(css.authTab, mode === 'login' && css.authTabActive)} onClick={() => { setMode('login'); setError(null) }}>登录</button>
        <button type="button" className={clsx(css.authTab, mode === 'register' && css.authTabActive)} onClick={() => { setMode('register'); setError(null) }}>注册</button>
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
        {mode === 'register' && (
          <input className={clsx(css.textInput, css.authTextInput)} type="password" placeholder="确认密码 *" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value) }} />
        )}
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
                className={clsx(css.actionButton, css.authSecondaryButton)}
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
