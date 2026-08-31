/**
 * 后端统一响应包装(对齐 com.dsh.console.common.ApiResponse)。
 *
 * success=true 时取 data;success=false 时取 error。
 */
export interface ApiResponse<T> {
  success: boolean
  data: T | null
  error: ApiError | null
}

export interface ApiError {
  code: string
  message: string
  details?: string[]
}

/**
 * 平台用户治理上下文(对齐 com.dsh.console.security.AuthContext)。
 *
 * 由后端从 JWT 解析后注入到 Controller,前端在 /api/auth/me 拿到。
 */
export interface AuthContext {
  platformUserId: string
  authSubject: string
  email: string
  loginName: string
  displayName: string
  roles: string[]
}

/**
 * 平台角色值(对齐后端 com.dsh.console.security.PlatformRole 与 platform_users.platform_roles 存储)。
 * 数据库存储全小写;Spring Security authority 由后端 toUpperCase 转换。
 */
export const PLATFORM_ROLE = {
  SYSTEM_ADMIN: 'system_admin',
  APP_ADMIN: 'app_admin',
} as const
