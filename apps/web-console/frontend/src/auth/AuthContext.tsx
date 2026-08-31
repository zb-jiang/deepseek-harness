import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { get } from '../api/client'
import type { AuthContext as MeDto } from '../api/types'

interface Me extends MeDto {
  status?: string
  platformRoles?: string[]
}

function normalizeMe(value: unknown): Me | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const platformRoles = Array.isArray(raw.platformRoles)
    ? raw.platformRoles.map(r => String(r))
    : []
  return {
    platformUserId: String(raw.platformUserId ?? raw.id ?? ''),
    authSubject: String(raw.authSubject ?? ''),
    email: String(raw.email ?? ''),
    loginName: String(raw.loginName ?? ''),
    displayName: String(raw.displayName ?? ''),
    roles: platformRoles,
    status: raw.status === undefined ? undefined : String(raw.status),
    platformRoles,
  }
}

interface AuthState {
  user: User | null
  session: Session | null
  me: Me | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshMe: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshMe = async () => {
    try {
      const result = await get<unknown>('/api/users/me')
      setMe(normalizeMe(result))
    } catch (e) {
      // 后端 401 时 axios 拦截器已 signOut,这里 swallow
      // biome-ignore lint/suspicious/noConsole: 启动期诊断
      console.warn('[auth] fetch me failed', e)
      setMe(null)
    }
  }

  useEffect(() => {
    let mounted = true

    // 初始拉取一次 session
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      if (data.session) {
        refreshMe().finally(() => mounted && setLoading(false))
      } else {
        setLoading(false)
      }
    })

    // 监听 session 变化(登录/登出/token 刷新)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) {
        void refreshMe()
      } else {
        setMe(null)
      }
    })

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // onAuthStateChange 会触发 refreshMe;这里同步再调一次确保 me 在 await 后已就绪
    await refreshMe()
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setMe(null)
    setSession(null)
  }

  return (
    <AuthContext.Provider
      value={{ user: session?.user ?? null, session, me, loading, signIn, signOut, refreshMe }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
