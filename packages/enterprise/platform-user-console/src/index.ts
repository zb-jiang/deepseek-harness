/**
 * Web Console provider for `ctx.platformUsers`: verifies Supabase Auth JWTs
 * locally via JWKS and reads the caller's governance record from the Web
 * Console backend (`GET /api/users/me`) with the user's bearer token.
 * Governance writes live in the Web Console backend.
 *
 * @module @deepseek-ai/dsh-platform-user-console
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
export const name = 'platform-user-console'

/** Default Web Console base URL, aligned with the other enterprise consumers. */
export const DEFAULT_WEB_CONSOLE_BASE_URL = 'http://127.0.0.1:8080'

/** The platform-user seam this provider registers into. */
export const inject = ['platformUsers']

/** Plugin config for the Web-Console-backed provider. */
export interface Config {
  /** Supabase project URL; only its Auth issuer is used for JWT verification. */
  supabaseUrl?: string
  /** Web Console backend base URL serving `GET /api/users/me`. */
  webConsoleBaseUrl?: string
}

export const Config: z<Config> = z.object({
  supabaseUrl: z.string(),
  webConsoleBaseUrl: z.string().default(DEFAULT_WEB_CONSOLE_BASE_URL),
})

/** Complete config after schemastery applies defaults. */
export interface ResolvedConfig {
  /** Supabase project URL; only its Auth issuer is used for JWT verification. */
  supabaseUrl: string
  /** Web Console backend base URL without a trailing slash. */
  webConsoleBaseUrl: string
}

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`platform-user-console: ${name} must be a non-empty string`)
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
    supabaseUrl: requireNonEmpty('supabaseUrl', config.supabaseUrl ?? ''),
    webConsoleBaseUrl: requireNonEmpty(
      'webConsoleBaseUrl',
      config.webConsoleBaseUrl ?? DEFAULT_WEB_CONSOLE_BASE_URL,
    ).replace(/\/+$/, ''),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`platform-user-console: user field "${field}" must be a non-empty string`)
  }
  return value
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error(`platform-user-console: user field "${field}" must be a string or null`)
  }
  return value
}

function readStatus(value: unknown): PlatformUserStatus {
  const status = readString(value, 'status')
  if (!['pending_approval', 'active', 'disabled', 'locked'].includes(status)) {
    throw new Error(`platform-user-console: unknown platform user status "${status}"`)
  }
  return status as PlatformUserStatus
}

function readRoles(value: unknown): readonly PlatformRole[] {
  if (!Array.isArray(value)) {
    throw new Error('platform-user-console: user field "platformRoles" must be a string array')
  }
  return value.map((entry) => {
    const role = readString(entry, 'platformRoles[]')
    if (!['system_admin', 'app_admin', 'normal_user'].includes(role)) {
      throw new Error(`platform-user-console: unknown platform role "${role}"`)
    }
    return role as PlatformRole
  })
}

/** Governance record as returned by the Web Console `GET /api/users/me` data field (camelCase). */
export interface MeUser {
  id: string
  authSubject: string
  loginName: string
  displayName: string
  email: string
  status: PlatformUserStatus
  platformRoles: readonly PlatformRole[]
  createdAt: string
  createdBy: string | null
  approvedAt: string | null
  approvedBy: string | null
  disabledAt: string | null
  disabledBy: string | null
  disabledReason: string | null
  lockedAt: string | null
  lockedBy: string | null
  lockedReason: string | null
}

/**
 * Unwrap the Web Console `ApiResponse` envelope and return the data field.
 * @param payload - parsed JSON body of the `/api/users/me` response.
 * @returns the data field value, or null when the backend reports no record.
 */
export function readMeResponse(payload: unknown): unknown {
  if (!isRecord(payload)) {
    throw new Error('platform-user-console: /api/users/me response must be an object')
  }
  if (payload.success !== true) {
    throw new PlatformUserError(
      `getUserByToken: /api/users/me reported failure: ${JSON.stringify(payload.error)}`,
      'PROVIDER_REQUEST_FAILED',
    )
  }
  return payload.data
}

/**
 * Validate and normalize one `/api/users/me` data record. Unknown fields
 * (e.g. `orgUnits`) are ignored.
 * @param value - raw data field value.
 * @returns the validated user record.
 */
export function readMeUser(value: unknown): MeUser {
  if (!isRecord(value)) {
    throw new PlatformUserError(
      'platform user not found for authenticated subject',
      'UNKNOWN_USER',
    )
  }
  return {
    id: readString(value.id, 'id'),
    authSubject: readString(value.authSubject, 'authSubject'),
    loginName: readString(value.loginName, 'loginName'),
    displayName: readString(value.displayName, 'displayName'),
    email: readString(value.email, 'email'),
    status: readStatus(value.status),
    platformRoles: readRoles(value.platformRoles),
    createdAt: readString(value.createdAt, 'createdAt'),
    createdBy: readOptionalString(value.createdBy, 'createdBy'),
    approvedAt: readOptionalString(value.approvedAt, 'approvedAt'),
    approvedBy: readOptionalString(value.approvedBy, 'approvedBy'),
    disabledAt: readOptionalString(value.disabledAt, 'disabledAt'),
    disabledBy: readOptionalString(value.disabledBy, 'disabledBy'),
    disabledReason: readOptionalString(value.disabledReason, 'disabledReason'),
    lockedAt: readOptionalString(value.lockedAt, 'lockedAt'),
    lockedBy: readOptionalString(value.lockedBy, 'lockedBy'),
    lockedReason: readOptionalString(value.lockedReason, 'lockedReason'),
  }
}

/**
 * Map one validated record into the seam's stable `PlatformUser` value.
 * @param user - validated record.
 * @returns the seam value.
 */
export function mapPlatformUser(user: MeUser): PlatformUser {
  return {
    id: user.id as PlatformUser['id'],
    authSubject: user.authSubject,
    loginName: user.loginName,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    platformRoles: user.platformRoles,
    createdAt: user.createdAt,
    ...(user.createdBy === null ? {} : { createdBy: user.createdBy as PlatformUser['id'] }),
    ...(user.approvedAt === null ? {} : { approvedAt: user.approvedAt }),
    ...(user.approvedBy === null ? {} : { approvedBy: user.approvedBy as PlatformUser['id'] }),
    ...(user.disabledAt === null ? {} : { disabledAt: user.disabledAt }),
    ...(user.disabledBy === null ? {} : { disabledBy: user.disabledBy as PlatformUser['id'] }),
    ...(user.disabledReason === null ? {} : { disabledReason: user.disabledReason }),
    ...(user.lockedAt === null ? {} : { lockedAt: user.lockedAt }),
    ...(user.lockedBy === null ? {} : { lockedBy: user.lockedBy as PlatformUser['id'] }),
    ...(user.lockedReason === null ? {} : { lockedReason: user.lockedReason }),
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

/**
 * Web-Console-backed read-only provider. Verifies JWTs locally via JWKS and
 * reads the caller's governance record from `GET /api/users/me` using the
 * user's own bearer token.
 */
export class ConsolePlatformUserProvider implements PlatformUserProvider {
  private readonly issuer: string

  /**
   * @param supabaseUrl - Supabase project URL; only the Auth issuer is used.
   * @param webConsoleBaseUrl - Web Console backend base URL without trailing slash.
   * @param jwks - JWKS key store for JWT signature verification.
   */
  constructor(
    supabaseUrl: string,
    private readonly webConsoleBaseUrl: string,
    private readonly jwks: ReturnType<typeof createRemoteJWKSet>,
  ) {
    this.issuer = `${supabaseUrl}/auth/v1`
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    await this.verifyJwt(accessToken)
    const payload = await this.readMe(accessToken)
    return mapPlatformUser(readMeUser(readMeResponse(payload)))
  }

  /** Verify the JWT locally; the backend re-verifies it, this only classifies bad tokens early. */
  private async verifyJwt(accessToken: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(accessToken, this.jwks, {
        issuer: this.issuer,
      })
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new PlatformUserError('JWT missing sub claim', 'AUTH_TOKEN_INVALID')
      }
    } catch (error) {
      if (error instanceof PlatformUserError) throw error
      throw new PlatformUserError(
        `getUserByToken: JWT verification failed: ${normalizeError(error).message}`,
        'AUTH_TOKEN_INVALID',
        { cause: normalizeError(error) },
      )
    }
  }

  /** Read the caller's governance record from the Web Console backend. */
  private async readMe(accessToken: string): Promise<unknown> {
    const response = await fetch(`${this.webConsoleBaseUrl}/api/users/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    const body = await response.text().catch(() => '')
    if (!response.ok) {
      throw new PlatformUserError(
        `getUserByToken: /api/users/me failed: ${response.status} ${body}`,
        'PROVIDER_REQUEST_FAILED',
      )
    }
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new PlatformUserError(
        `getUserByToken: invalid JSON response: ${normalizeError(error).message}`,
        'PROVIDER_REQUEST_FAILED',
        { cause: normalizeError(error) },
      )
    }
  }
}

/**
 * Register the Web-Console-backed platform-user provider.
 * @param ctx - Cordis context carrying `ctx.platformUsers`.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const jwksUrl = `${resolved.supabaseUrl}/auth/v1/.well-known/jwks.json`
  ctx.platformUsers.registerProvider(new ConsolePlatformUserProvider(
    resolved.supabaseUrl,
    resolved.webConsoleBaseUrl,
    createRemoteJWKSet(new URL(jwksUrl)),
  ))
}
