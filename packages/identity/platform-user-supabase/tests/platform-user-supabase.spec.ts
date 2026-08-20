import { describe, expect, it } from 'vitest'
import type {
  PlatformUserApproval,
  PlatformUserDisable,
  PlatformUserId,
  PlatformUserLock,
  PlatformUserRegistration,
  PlatformUserRestore,
  PlatformUserRoleUpdate,
} from '@deepseek-ai/dsh-platform-user'
import {
  mapAuditEvent,
  mapPlatformUser,
  readAuditEventRow,
  readPlatformUserRow,
  resolveConfig,
  SupabasePlatformUserProvider,
  type AuditEventRow,
  type AuthBridge,
  type PlatformUserRow,
  type PlatformUserStore,
} from '../src/index.ts'

const row = (overrides: Partial<PlatformUserRow> = {}): PlatformUserRow => ({
  id: 'user-1',
  auth_subject: 'auth-1',
  login_name: 'alice',
  display_name: 'Alice',
  email: 'alice@example.com',
  status: 'pending_approval',
  platform_roles: [],
  created_at: '2026-08-19T00:00:00.000Z',
  created_by: null,
  approved_at: null,
  approved_by: null,
  disabled_at: null,
  disabled_by: null,
  disabled_reason: null,
  locked_at: null,
  locked_by: null,
  locked_reason: null,
  ...overrides,
})

const auditRow = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: 'audit-1',
  event_type: 'register_pending',
  target_user_id: 'user-1',
  operator_id: null,
  details: {},
  created_at: '2026-08-19T00:00:00.000Z',
  ...overrides,
})

class StubAuthBridge implements AuthBridge {
  private nextId = 1
  private readonly tokens = new Map<string, string>()

  async createAuthUser(_email: string, _password: string): Promise<string> {
    return `auth-subject-${this.nextId++}`
  }

  async signInWithPassword(_email: string, _password: string): Promise<{ accessToken: string; userId: string }> {
    const userId = `auth-subject-${this.nextId++}`
    const accessToken = `token-${this.nextId++}`
    this.tokens.set(accessToken, userId)
    return { accessToken, userId }
  }

  async getUserByToken(accessToken: string): Promise<string> {
    const userId = this.tokens.get(accessToken)
    if (userId === undefined) {
      throw new Error('token not found')
    }
    return userId
  }
}

class MemoryStore implements PlatformUserStore {
  readonly rows = new Map<string, PlatformUserRow>()
  readonly auditRows: AuditEventRow[] = []
  private nextAuditId = 1

  constructor(seed: PlatformUserRow[] = [row()]) {
    for (const entry of seed) this.rows.set(entry.id, entry)
  }

  async insert(record: Omit<PlatformUserRow, 'id' | 'approved_at' | 'approved_by' | 'disabled_at' | 'disabled_by' | 'disabled_reason' | 'locked_at' | 'locked_by' | 'locked_reason'>): Promise<PlatformUserRow> {
    const created = row({
      id: 'user-2',
      ...record,
      approved_at: null,
      approved_by: null,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
      locked_at: null,
      locked_by: null,
      locked_reason: null,
    })
    this.rows.set(created.id, created)
    return created
  }

  getById(id: string): Promise<PlatformUserRow | undefined> {
    return Promise.resolve(this.rows.get(id))
  }

  getByAuthSubject(authSubject: string): Promise<PlatformUserRow | undefined> {
    return Promise.resolve([...this.rows.values()].find(entry => entry.auth_subject === authSubject))
  }

  list(): Promise<readonly PlatformUserRow[]> {
    return Promise.resolve([...this.rows.values()])
  }

  async update(id: string, patch: Partial<PlatformUserRow>): Promise<PlatformUserRow> {
    const current = this.rows.get(id)
    if (current === undefined) throw new Error(`missing ${id}`)
    const updated = row({ ...current, ...patch })
    this.rows.set(id, updated)
    return updated
  }

  async insertAudit(event: { event_type: AuditEventRow['event_type']; target_user_id: string; operator_id: string | null; details: Record<string, unknown>; created_at: string }): Promise<void> {
    this.auditRows.push(auditRow({
      id: `audit-${this.nextAuditId++}`,
      ...event,
    }))
  }

  listAudit(limit?: number): Promise<readonly AuditEventRow[]> {
    const reversed = [...this.auditRows].reverse()
    return Promise.resolve(limit !== undefined ? reversed.slice(0, limit) : reversed)
  }
}

describe('dsh-platform-user-supabase', () => {
  it('resolves config defaults and rejects empty required fields', () => {
    expect(resolveConfig({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      anonKey: 'anon-secret',
    })).toEqual({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      anonKey: 'anon-secret',
      usersTable: 'platform_users',
      auditTable: 'audit_events',
    })
    expect(() => resolveConfig({
      url: '',
      serviceRoleKey: 'secret',
      anonKey: 'anon-secret',
    })).toThrow('url must be a non-empty string')
    expect(() => resolveConfig({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      anonKey: '',
    })).toThrow('anonKey must be a non-empty string')
  })

  it('validates and maps raw rows', () => {
    const validated = readPlatformUserRow(row({
      status: 'active',
      platform_roles: ['normal_user'],
      approved_by: 'admin-1',
      approved_at: '2026-08-19T01:00:00.000Z',
    }))
    expect(mapPlatformUser(validated)).toEqual({
      id: 'user-1' as PlatformUserId,
      authSubject: 'auth-1',
      loginName: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'active',
      platformRoles: ['normal_user'],
      createdAt: '2026-08-19T00:00:00.000Z',
      approvedBy: 'admin-1' as PlatformUserId,
      approvedAt: '2026-08-19T01:00:00.000Z',
    })
  })

  it('creates pending users and filters listed users in memory', async () => {
    const store = new MemoryStore([
      row({ id: 'user-1', status: 'pending_approval' }),
      row({ id: 'user-3', status: 'active', platform_roles: ['app_admin'] }),
    ])
    const provider = new SupabasePlatformUserProvider(store, new StubAuthBridge())
    const created = await provider.registerPendingUser({
      authSubject: 'auth-2',
      loginName: 'bob',
      displayName: 'Bob',
      email: 'bob@example.com',
    } satisfies PlatformUserRegistration)
    expect(created.status).toBe('pending_approval')
    const listed = await provider.list({ statuses: ['active'], role: 'app_admin' })
    expect(listed.map(entry => entry.id)).toEqual(['user-3'])
  })

  it('updates approval, role, disable, lock, and restore fields through the store', async () => {
    const store = new MemoryStore([
      row({ id: 'user-1', status: 'pending_approval' }),
    ])
    const provider = new SupabasePlatformUserProvider(store, new StubAuthBridge())
    await expect(provider.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: ['normal_user'],
    } satisfies PlatformUserApproval)).resolves.toMatchObject({
      status: 'active',
      platformRoles: ['normal_user'],
      approvedBy: 'admin-1' as PlatformUserId,
    })
    await expect(provider.setRoles('user-1' as PlatformUserId, {
      changedBy: 'admin-2' as PlatformUserId,
      platformRoles: ['system_admin'],
    } satisfies PlatformUserRoleUpdate)).resolves.toMatchObject({
      platformRoles: ['system_admin'],
    })
    await expect(provider.disable('user-1' as PlatformUserId, {
      disabledBy: 'admin-3' as PlatformUserId,
      reason: 'left company',
    } satisfies PlatformUserDisable)).resolves.toMatchObject({
      status: 'disabled',
      disabledBy: 'admin-3' as PlatformUserId,
      disabledReason: 'left company',
    })
    await expect(provider.lock('user-1' as PlatformUserId, {
      lockedBy: 'admin-4' as PlatformUserId,
      reason: 'security event',
    } satisfies PlatformUserLock)).resolves.toMatchObject({
      status: 'locked',
      lockedBy: 'admin-4' as PlatformUserId,
      lockedReason: 'security event',
    })
    await expect(provider.restore('user-1' as PlatformUserId, {
      restoredBy: 'admin-5' as PlatformUserId,
    } satisfies PlatformUserRestore)).resolves.toMatchObject({
      status: 'active',
    })
  })

  it('validates and maps audit event rows', () => {
    const validated = readAuditEventRow(auditRow({
      event_type: 'approve',
      target_user_id: 'user-1',
      operator_id: 'admin-1',
      details: { platformRoles: ['normal_user'] },
    }))
    expect(mapAuditEvent(validated)).toEqual({
      id: 'audit-1',
      eventType: 'approve',
      targetUserId: 'user-1' as PlatformUserId,
      operatorId: 'admin-1' as PlatformUserId,
      details: { platformRoles: ['normal_user'] },
      createdAt: '2026-08-19T00:00:00.000Z',
    })
  })

  it('records audit events for governance operations', async () => {
    const store = new MemoryStore([
      row({ id: 'user-1', status: 'pending_approval' }),
    ])
    const provider = new SupabasePlatformUserProvider(store, new StubAuthBridge())
    await provider.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: ['normal_user'],
    } satisfies PlatformUserApproval)
    await provider.disable('user-1' as PlatformUserId, {
      disabledBy: 'admin-2' as PlatformUserId,
    } satisfies PlatformUserDisable)
    const events = await provider.listAuditEvents()
    expect(events.map(e => e.eventType)).toEqual(['disable', 'approve'])
    const limited = await provider.listAuditEvents(1)
    expect(limited).toHaveLength(1)
    expect(limited[0]?.eventType).toBe('disable')
  })

  it('signs up a user via the auth bridge and creates a pending record', async () => {
    const store = new MemoryStore()
    const provider = new SupabasePlatformUserProvider(store, new StubAuthBridge())
    const created = await provider.signUp('bob@example.com', 'pw', 'bob', 'Bob')
    expect(created.status).toBe('pending_approval')
    expect(created.email).toBe('bob@example.com')
    expect(store.auditRows).toHaveLength(1)
    expect(store.auditRows[0]?.event_type).toBe('register_pending')
  })

  it('signs in and resolves a user by token', async () => {
    const store = new MemoryStore([
      row({ id: 'user-1', auth_subject: 'auth-subject-1', email: 'alice@example.com' }),
    ])
    const auth = new StubAuthBridge()
    const provider = new SupabasePlatformUserProvider(store, auth)
    const signInResult = await provider.signIn('alice@example.com', 'pw')
    expect(signInResult.accessToken.length).toBeGreaterThan(0)
    expect(signInResult.platformUser.email).toBe('alice@example.com')
    const resolved = await provider.getUserByToken(signInResult.accessToken)
    expect(resolved.email).toBe('alice@example.com')
  })
})
