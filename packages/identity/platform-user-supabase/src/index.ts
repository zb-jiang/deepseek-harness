/**
 * Supabase provider for `ctx.platformUsers`: stores platform-user governance
 * rows in one Postgres table while leaving login and session auth to Supabase
 * Auth itself.
 *
 * @module @deepseek-ai/dsh-platform-user-supabase
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createClient } from '@supabase/supabase-js'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  type AuditEvent,
  type AuditEventType,
  type AuthSignInResult,
  type PlatformRole,
  type PlatformUser,
  type PlatformUserApproval,
  type PlatformUserDisable,
  type PlatformUserId,
  type PlatformUserListRequest,
  type PlatformUserLock,
  type PlatformUserProvider,
  type PlatformUserRegistration,
  type PlatformUserRestore,
  type PlatformUserRoleUpdate,
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
  /** Service-role key used for server-side governance operations. */
  serviceRoleKey?: string
  /** Anon key used for Supabase Auth client operations (signIn, getUser). */
  anonKey?: string
  /** Table storing platform-user governance rows. */
  usersTable?: string
  /** Table storing audit-event rows. */
  auditTable?: string
}

export const Config: z<Config> = z.object({
  url: z.string(),
  serviceRoleKey: z.string().role('secret'),
  anonKey: z.string().role('secret'),
  usersTable: z.string().default('platform_users'),
  auditTable: z.string().default('audit_events'),
})

/** Complete config after schemastery applies defaults. */
export interface ResolvedConfig {
  /** Supabase project URL. */
  url: string
  /** Service-role key used for server-side governance operations. */
  serviceRoleKey: string
  /** Anon key used for Supabase Auth client operations (signIn, getUser). */
  anonKey: string
  /** Table storing platform-user governance rows. */
  usersTable: string
  /** Table storing audit-event rows. */
  auditTable: string
}

/** Raw Supabase row expected from the governance table. */
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

/** Insert payload for a new row. */
interface PlatformUserInsertRow {
  auth_subject: string
  login_name: string
  display_name: string
  email: string
  status: PlatformUserStatus
  platform_roles: readonly PlatformRole[]
  created_at: string
  created_by: string | null
}

/** Update payload for an existing row. */
interface PlatformUserUpdateRow {
  status?: PlatformUserStatus
  platform_roles?: readonly PlatformRole[]
  approved_at?: string | null
  approved_by?: string | null
  disabled_at?: string | null
  disabled_by?: string | null
  disabled_reason?: string | null
  locked_at?: string | null
  locked_by?: string | null
  locked_reason?: string | null
}

/** Raw Supabase row expected from the audit-events table. */
export interface AuditEventRow {
  id: string
  event_type: AuditEventType
  target_user_id: string
  operator_id: string | null
  details: Record<string, unknown>
  created_at: string
}

/** Insert payload for a new audit row. */
interface AuditEventInsertRow {
  event_type: AuditEventType
  target_user_id: string
  operator_id: string | null
  details: Record<string, unknown>
  created_at: string
}

/** Auth operations bridge backed by Supabase Auth. */
export interface AuthBridge {
  /** Create an auth user and return its subject id. */
  createAuthUser(email: string, password: string): Promise<string>
  /** Sign in with password and return the access token plus auth subject id. */
  signInWithPassword(email: string, password: string): Promise<{ accessToken: string; userId: string }>
  /** Validate an access token and return the auth subject id. */
  getUserByToken(accessToken: string): Promise<string>
}

/** Minimal storage bridge the provider needs from Supabase. */
export interface PlatformUserStore {
  insert(row: PlatformUserInsertRow): Promise<PlatformUserRow>
  getById(id: string): Promise<PlatformUserRow | undefined>
  getByAuthSubject(authSubject: string): Promise<PlatformUserRow | undefined>
  list(): Promise<readonly PlatformUserRow[]>
  update(id: string, patch: PlatformUserUpdateRow): Promise<PlatformUserRow>
  insertAudit(event: AuditEventInsertRow): Promise<void>
  listAudit(limit?: number): Promise<readonly AuditEventRow[]>
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
    serviceRoleKey: requireNonEmpty('serviceRoleKey', config.serviceRoleKey ?? ''),
    anonKey: requireNonEmpty('anonKey', config.anonKey ?? ''),
    usersTable: requireNonEmpty('usersTable', config.usersTable ?? 'platform_users'),
    auditTable: requireNonEmpty('auditTable', config.auditTable ?? 'audit_events'),
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
    id: row.id as PlatformUserId,
    authSubject: row.auth_subject,
    loginName: row.login_name,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    platformRoles: row.platform_roles,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by as PlatformUserId }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by as PlatformUserId }),
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    ...(row.disabled_by === null ? {} : { disabledBy: row.disabled_by as PlatformUserId }),
    ...(row.disabled_reason === null ? {} : { disabledReason: row.disabled_reason }),
    ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
    ...(row.locked_by === null ? {} : { lockedBy: row.locked_by as PlatformUserId }),
    ...(row.locked_reason === null ? {} : { lockedReason: row.locked_reason }),
  }
}

const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  'register_pending', 'approve', 'set_roles', 'disable', 'lock', 'restore',
]

function readAuditEventType(value: unknown): AuditEventType {
  const type = readString(value, 'event_type')
  if (!AUDIT_EVENT_TYPES.includes(type as AuditEventType)) {
    throw new Error(`platform-user-supabase: unknown audit event type "${type}"`)
  }
  return type as AuditEventType
}

/**
 * Validate and normalize one raw audit-event row.
 * @param value - raw result data.
 * @returns the validated row.
 */
export function readAuditEventRow(value: unknown): AuditEventRow {
  if (!isRecord(value)) {
    throw new Error('platform-user-supabase: an audit row must be an object')
  }
  const details = value.details
  return {
    id: readString(value.id, 'id'),
    event_type: readAuditEventType(value.event_type),
    target_user_id: readString(value.target_user_id, 'target_user_id'),
    operator_id: readOptionalString(value.operator_id, 'operator_id'),
    details: isRecord(details) ? details : {},
    created_at: readString(value.created_at, 'created_at'),
  }
}

/**
 * Map one raw audit row into the seam's stable `AuditEvent` value.
 * @param row - validated row.
 * @returns the seam value.
 */
export function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    targetUserId: row.target_user_id as PlatformUserId,
    operatorId: row.operator_id === null ? null : row.operator_id as PlatformUserId,
    details: row.details,
    createdAt: row.created_at,
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function now(): string {
  return new Date().toISOString()
}

/**
 * Governance provider backed by one Supabase table.
 */
export class SupabasePlatformUserProvider implements PlatformUserProvider {
  constructor(
    private readonly store: PlatformUserStore,
    private readonly auth: AuthBridge,
  ) {}

  private async audit(
    eventType: AuditEventType,
    targetUserId: string,
    operatorId: PlatformUserId | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.insertAudit({
      event_type: eventType,
      target_user_id: targetUserId,
      operator_id: operatorId,
      details,
      created_at: now(),
    })
  }

  async registerPendingUser(request: PlatformUserRegistration): Promise<PlatformUser> {
    const row = await this.store.insert({
      auth_subject: request.authSubject,
      login_name: request.loginName,
      display_name: request.displayName,
      email: request.email,
      status: 'pending_approval',
      platform_roles: [],
      created_at: now(),
      created_by: request.createdBy ?? null,
    })
    const user = mapPlatformUser(row)
    await this.audit('register_pending', row.id, request.createdBy ?? null, {
      loginName: request.loginName,
      email: request.email,
    })
    return user
  }

  async getById(id: PlatformUserId): Promise<PlatformUser | undefined> {
    const row = await this.store.getById(id)
    return row === undefined ? undefined : mapPlatformUser(row)
  }

  async getByAuthSubject(authSubject: string): Promise<PlatformUser | undefined> {
    const row = await this.store.getByAuthSubject(authSubject)
    return row === undefined ? undefined : mapPlatformUser(row)
  }

  async list(request?: PlatformUserListRequest): Promise<readonly PlatformUser[]> {
    const rows = await this.store.list()
    return rows
      .filter(row => request?.statuses === undefined || request.statuses.includes(row.status))
      .filter(row => request?.role === undefined || row.platform_roles.includes(request.role))
      .map(mapPlatformUser)
  }

  async approve(id: PlatformUserId, request: PlatformUserApproval): Promise<PlatformUser> {
    const row = await this.store.update(id, {
      status: 'active',
      platform_roles: request.platformRoles,
      approved_at: now(),
      approved_by: request.approvedBy,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
      locked_at: null,
      locked_by: null,
      locked_reason: null,
    })
    const user = mapPlatformUser(row)
    await this.audit('approve', id, request.approvedBy, {
      platformRoles: [...request.platformRoles],
    })
    return user
  }

  async setRoles(id: PlatformUserId, request: PlatformUserRoleUpdate): Promise<PlatformUser> {
    const row = await this.store.update(id, {
      platform_roles: request.platformRoles,
    })
    const user = mapPlatformUser(row)
    await this.audit('set_roles', id, request.changedBy, {
      platformRoles: [...request.platformRoles],
    })
    return user
  }

  async disable(id: PlatformUserId, request: PlatformUserDisable): Promise<PlatformUser> {
    const row = await this.store.update(id, {
      status: 'disabled',
      disabled_at: now(),
      disabled_by: request.disabledBy,
      disabled_reason: request.reason ?? null,
      locked_at: null,
      locked_by: null,
      locked_reason: null,
    })
    const user = mapPlatformUser(row)
    await this.audit('disable', id, request.disabledBy, {
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    return user
  }

  async lock(id: PlatformUserId, request: PlatformUserLock): Promise<PlatformUser> {
    const row = await this.store.update(id, {
      status: 'locked',
      locked_at: now(),
      locked_by: request.lockedBy,
      locked_reason: request.reason ?? null,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
    })
    const user = mapPlatformUser(row)
    await this.audit('lock', id, request.lockedBy, {
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    return user
  }

  async restore(id: PlatformUserId, request: PlatformUserRestore): Promise<PlatformUser> {
    const row = await this.store.update(id, {
      status: 'active',
      approved_by: request.restoredBy,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
      locked_at: null,
      locked_by: null,
      locked_reason: null,
    })
    const user = mapPlatformUser(row)
    await this.audit('restore', id, request.restoredBy, {})
    return user
  }

  async signUp(email: string, password: string, loginName: string, displayName: string): Promise<PlatformUser> {
    const authSubject = await this.auth.createAuthUser(email, password)
    return await this.registerPendingUser({
      authSubject,
      loginName,
      displayName,
      email,
    })
  }

  async signIn(email: string, password: string): Promise<AuthSignInResult> {
    const { accessToken, userId } = await this.auth.signInWithPassword(email, password)
    const platformUser = await this.getByAuthSubject(userId)
    if (platformUser === undefined) {
      throw new PlatformUserError(
        'platform user not found for authenticated subject',
        'UNKNOWN_USER',
      )
    }
    return { accessToken, platformUser }
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    const userId = await this.auth.getUserByToken(accessToken)
    const platformUser = await this.getByAuthSubject(userId)
    if (platformUser === undefined) {
      throw new PlatformUserError(
        'platform user not found for authenticated subject',
        'UNKNOWN_USER',
      )
    }
    return platformUser
  }

  async listAuditEvents(limit?: number): Promise<readonly AuditEvent[]> {
    const rows = await this.store.listAudit(limit)
    return rows.map(mapAuditEvent)
  }
}

function expectNoError(error: unknown): void {
  if (error == null) return
  throw new PlatformUserError(
    `platform-user-supabase request failed: ${normalizeError(error).message}`,
    'PROVIDER_REQUEST_FAILED',
    { cause: normalizeError(error) },
  )
}

/**
 * Build the store bridge over one Supabase client and table.
 * @param url - Supabase project URL.
 * @param serviceRoleKey - service-role key.
 * @param usersTable - governance table name.
 * @param auditTable - audit-events table name.
 * @returns a store bridge consumed by the provider.
 */
export function createSupabaseStore(
  url: string,
  serviceRoleKey: string,
  usersTable: string,
  auditTable: string,
): PlatformUserStore {
  const client = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  return {
    async insert(row): Promise<PlatformUserRow> {
      const result = await client
        .from(usersTable)
        .insert(row)
        .select('*')
        .single()
      expectNoError(result.error)
      return readPlatformUserRow(result.data as unknown)
    },
    async getById(id): Promise<PlatformUserRow | undefined> {
      const result = await client
        .from(usersTable)
        .select('*')
        .eq('id', id)
        .maybeSingle()
      expectNoError(result.error)
      return result.data == null ? undefined : readPlatformUserRow(result.data as unknown)
    },
    async getByAuthSubject(authSubject): Promise<PlatformUserRow | undefined> {
      const result = await client
        .from(usersTable)
        .select('*')
        .eq('auth_subject', authSubject)
        .maybeSingle()
      expectNoError(result.error)
      return result.data == null ? undefined : readPlatformUserRow(result.data as unknown)
    },
    async list(): Promise<readonly PlatformUserRow[]> {
      const result = await client
        .from(usersTable)
        .select('*')
        .order('created_at', { ascending: true })
      expectNoError(result.error)
      const data = result.data as unknown
      if (!Array.isArray(data)) {
        throw new Error('platform-user-supabase: list response must be an array')
      }
      return data.map(readPlatformUserRow)
    },
    async update(id, patch): Promise<PlatformUserRow> {
      const result = await client
        .from(usersTable)
        .update(patch)
        .eq('id', id)
        .select('*')
        .single()
      expectNoError(result.error)
      return readPlatformUserRow(result.data as unknown)
    },
    async insertAudit(event): Promise<void> {
      const result = await client
        .from(auditTable)
        .insert(event)
      expectNoError(result.error)
    },
    async listAudit(limit): Promise<readonly AuditEventRow[]> {
      let query = client
        .from(auditTable)
        .select('*')
        .order('created_at', { ascending: false })
      if (limit !== undefined) {
        query = query.limit(limit)
      }
      const result = await query
      expectNoError(result.error)
      const data = result.data as unknown
      if (!Array.isArray(data)) {
        throw new Error('platform-user-supabase: audit list response must be an array')
      }
      return data.map(readAuditEventRow)
    },
  }
}

/**
 * Build the auth bridge over Supabase Auth clients.
 * @param url - Supabase project URL.
 * @param serviceRoleKey - service-role key for admin auth operations.
 * @param anonKey - anon key for client-side auth operations.
 * @returns an auth bridge consumed by the provider.
 */
export function createSupabaseAuthBridge(
  url: string,
  serviceRoleKey: string,
  anonKey: string,
): AuthBridge {
  const adminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anonClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    async createAuthUser(email: string, password: string): Promise<string> {
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (error !== null) {
        throw new PlatformUserError(
          `signUp: failed to create auth user: ${error.message}`,
          'AUTH_SIGNUP_FAILED',
          { cause: error },
        )
      }
      const userId = data.user?.id
      if (userId === undefined) {
        throw new PlatformUserError('signUp: no user returned', 'AUTH_SIGNUP_FAILED')
      }
      return userId
    },
    async signInWithPassword(email: string, password: string): Promise<{ accessToken: string; userId: string }> {
      const { data, error } = await anonClient.auth.signInWithPassword({ email, password })
      if (error !== null) {
        throw new PlatformUserError(
          `signIn: authentication failed: ${error.message}`,
          'AUTH_SIGNIN_FAILED',
          { cause: error },
        )
      }
      const accessToken = data.session?.access_token
      const userId = data.user?.id
      if (accessToken === undefined || userId === undefined) {
        throw new PlatformUserError('signIn: no session returned', 'AUTH_SIGNIN_FAILED')
      }
      return { accessToken, userId }
    },
    async getUserByToken(accessToken: string): Promise<string> {
      const { data, error } = await anonClient.auth.getUser(accessToken)
      if (error !== null) {
        throw new PlatformUserError(
          `getUserByToken: token validation failed: ${error.message}`,
          'AUTH_TOKEN_INVALID',
          { cause: error },
        )
      }
      const userId = data.user?.id
      if (userId === undefined) {
        throw new PlatformUserError('getUserByToken: no user returned', 'AUTH_TOKEN_INVALID')
      }
      return userId
    },
  }
}

/**
 * Register the Supabase-backed platform-user provider.
 * @param ctx - Cordis context carrying `ctx.platformUsers`.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.platformUsers.registerProvider(new SupabasePlatformUserProvider(
    createSupabaseStore(resolved.url, resolved.serviceRoleKey, resolved.usersTable, resolved.auditTable),
    createSupabaseAuthBridge(resolved.url, resolved.serviceRoleKey, resolved.anonKey),
  ))
}
