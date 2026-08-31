/**
 * Supabase provider for `ctx.platformUsers`: verifies Supabase Auth JWTs
 * locally via JWKS and reads the platform_users row through RLS self-read
 * (anon key + user JWT). Governance writes live in the Web Console backend.
 *
 * @module @deepseek-ai/dsh-platform-user-supabase
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  type PlatformUser,
  type PlatformRole,
  type PlatformUserProvider,
  type PlatformUserStatus,
} from '@deepseek-ai/dsh-platform-user'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-supabase'

/** The platform-user seam this provider registers into. */
export const inject = ['platformUsers']

/** Plugin config for the Supabase-backed provider. */
export interface Config {
  /** Supabase project URL. */
  url?: string
  /** Anon key used for RLS-scoped user queries. */
  anonKey?: string
  /** Table storing platform-user rows. */
  usersTable?: string
}

export const Config: z<Config> = z.object({
  url: z.string(),
  anonKey: z.string().role('secret'),
  usersTable: z.string().default('platform_users'),
})

/** Complete config after schemastery applies defaults. */
export interface ResolvedConfig {
  /** Supabase project URL. */
  url: string
  /** Anon key used for RLS-scoped user queries. */
  anonKey: string
  /** Table storing platform-user rows. */
  usersTable: string
}

/** Raw Supabase row expected from the platform_users table. */
export interface PlatformUserRow {
  id: string
  auth_subject: string
  login_name: string
  display_name: string
  email: string
  status: PlatformUserStatus
  platform_roles: readonly PlatformRole[]
  created_at: string
  created_by: string | null
  approved_at: string | null
  approved_by: string | null
  disabled_at: string | null
  disabled_by: string | null
  disabled_reason: string | null
  locked_at: string | null
  locked_by: string | null
  locked_reason: string | null
}

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`platform-user-supabase: ${name} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the runtime spec from plugin config.
 * @param config - raw plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    url: requireNonEmpty('url', config.url ?? ''),
    anonKey: requireNonEmpty('anonKey', config.anonKey ?? ''),
    usersTable: requireNonEmpty('usersTable', config.usersTable ?? 'platform_users'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`platform-user-supabase: row field "${field}" must be a non-empty string`)
  }
  return value
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error(`platform-user-supabase: row field "${field}" must be a string or null`)
  }
  return value
}

function readStatus(value: unknown): PlatformUserStatus {
  const status = readString(value, 'status')
  if (!['pending_approval', 'active', 'disabled', 'locked'].includes(status)) {
    throw new Error(`platform-user-supabase: unknown platform user status "${status}"`)
  }
  return status as PlatformUserStatus
}

function readRoles(value: unknown): readonly PlatformRole[] {
  if (!Array.isArray(value)) {
    throw new Error('platform-user-supabase: row field "platform_roles" must be a string array')
  }
  return value.map((entry) => {
    const role = readString(entry, 'platform_roles[]')
    if (!['system_admin', 'app_admin', 'normal_user'].includes(role)) {
      throw new Error(`platform-user-supabase: unknown platform role "${role}"`)
    }
    return role as PlatformRole
  })
}

/**
 * Validate and normalize one raw Supabase row.
 * @param value - raw result data.
 * @returns the validated row.
 */
export function readPlatformUserRow(value: unknown): PlatformUserRow {
  if (!isRecord(value)) {
    throw new Error('platform-user-supabase: a user row must be an object')
  }
  return {
    id: readString(value.id, 'id'),
    auth_subject: readString(value.auth_subject, 'auth_subject'),
    login_name: readString(value.login_name, 'login_name'),
    display_name: readString(value.display_name, 'display_name'),
    email: readString(value.email, 'email'),
    status: readStatus(value.status),
    platform_roles: readRoles(value.platform_roles),
    created_at: readString(value.created_at, 'created_at'),
    created_by: readOptionalString(value.created_by, 'created_by'),
    approved_at: readOptionalString(value.approved_at, 'approved_at'),
    approved_by: readOptionalString(value.approved_by, 'approved_by'),
    disabled_at: readOptionalString(value.disabled_at, 'disabled_at'),
    disabled_by: readOptionalString(value.disabled_by, 'disabled_by'),
    disabled_reason: readOptionalString(value.disabled_reason, 'disabled_reason'),
    locked_at: readOptionalString(value.locked_at, 'locked_at'),
    locked_by: readOptionalString(value.locked_by, 'locked_by'),
    locked_reason: readOptionalString(value.locked_reason, 'locked_reason'),
  }
}

/**
 * Map one raw row into the seam's stable `PlatformUser` value.
 * @param row - validated row.
 * @returns the seam value.
 */
export function mapPlatformUser(row: PlatformUserRow): PlatformUser {
  return {
    id: row.id as PlatformUser['id'],
    authSubject: row.auth_subject,
    loginName: row.login_name,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    platformRoles: row.platform_roles,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by as PlatformUser['id'] }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by as PlatformUser['id'] }),
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    ...(row.disabled_by === null ? {} : { disabledBy: row.disabled_by as PlatformUser['id'] }),
    ...(row.disabled_reason === null ? {} : { disabledReason: row.disabled_reason }),
    ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
    ...(row.locked_by === null ? {} : { lockedBy: row.locked_by as PlatformUser['id'] }),
    ...(row.locked_reason === null ? {} : { lockedReason: row.locked_reason }),
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

/**
 * Supabase-backed read-only provider. Verifies JWTs locally via JWKS and
 * reads platform_users through RLS self-read (anon key + user JWT).
 */
export class SupabasePlatformUserProvider implements PlatformUserProvider {
  private readonly issuer: string

  /**
   * @param url - Supabase project URL.
   * @param anonKey - anon key for RLS-scoped queries.
   * @param usersTable - platform_users table name.
   * @param jwks - JWKS key store for JWT signature verification.
   */
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly usersTable: string,
    private readonly jwks: ReturnType<typeof createRemoteJWKSet>,
  ) {
    this.issuer = `${url}/auth/v1`
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    const authSubject = await this.verifyJwt(accessToken)
    return await this.readPlatformUser(authSubject, accessToken)
  }

  /** Verify the JWT locally and extract the `sub` claim. */
  private async verifyJwt(accessToken: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(accessToken, this.jwks, {
        issuer: this.issuer,
      })
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new PlatformUserError('JWT missing sub claim', 'AUTH_TOKEN_INVALID')
      }
      return payload.sub
    } catch (error) {
      if (error instanceof PlatformUserError) throw error
      throw new PlatformUserError(
        `getUserByToken: JWT verification failed: ${normalizeError(error).message}`,
        'AUTH_TOKEN_INVALID',
        { cause: normalizeError(error) },
      )
    }
  }

  /** Read the platform_users row via a user-scoped Supabase client (RLS self-read). */
  private async readPlatformUser(authSubject: string, accessToken: string): Promise<PlatformUser> {
    // RLS 策略只检查请求携带的 JWT,无需建立完整 session。
    // 直接走 Supabase REST API,避免 supabase-js setSession 因缺少 refresh token 失败。
    const url = new URL(`${this.url}/rest/v1/${this.usersTable}`)
    url.searchParams.set('auth_subject', `eq.${authSubject}`)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: this.anonKey,
        accept: 'application/vnd.pgrst.object+json',
      },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new PlatformUserError(
        `getUserByToken: query failed: ${response.status} ${body}`,
        'PROVIDER_REQUEST_FAILED',
      )
    }
    const text = await response.text()
    if (text.length === 0 || text === 'null') {
      throw new PlatformUserError(
        'platform user not found for authenticated subject',
        'UNKNOWN_USER',
      )
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new PlatformUserError(
        `getUserByToken: invalid JSON response: ${normalizeError(error).message}`,
        'PROVIDER_REQUEST_FAILED',
        { cause: normalizeError(error) },
      )
    }
    return mapPlatformUser(readPlatformUserRow(data))
  }
}

/**
 * Register the Supabase-backed platform-user provider.
 * @param ctx - Cordis context carrying `ctx.platformUsers`.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const jwksUrl = `${resolved.url}/auth/v1/.well-known/jwks.json`
  ctx.platformUsers.registerProvider(new SupabasePlatformUserProvider(
    resolved.url,
    resolved.anonKey,
    resolved.usersTable,
    createRemoteJWKSet(new URL(jwksUrl)),
  ))
}
