import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import PlatformUserService, {
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
} from '../src/index.ts'

const user = (overrides: Partial<PlatformUser> = {}): PlatformUser => ({
  id: 'user-1' as PlatformUserId,
  authSubject: 'auth-1',
  loginName: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  status: 'pending_approval',
  platformRoles: [],
  createdAt: '2026-08-19T00:00:00.000Z',
  ...overrides,
})

class StubProvider implements PlatformUserProvider {
  readonly users = new Map<PlatformUserId, PlatformUser>()
  readonly auditEvents: AuditEvent[] = []
  private nextAuthId = 1
  private readonly tokenToUserId = new Map<string, string>()

  constructor(seed: PlatformUser[] = []) {
    for (const entry of seed) this.users.set(entry.id, entry)
  }

  async registerPendingUser(request: PlatformUserRegistration): Promise<PlatformUser> {
    const created = user({
      authSubject: request.authSubject,
      loginName: request.loginName,
      displayName: request.displayName,
      email: request.email,
      ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
    })
    this.users.set(created.id, created)
    this.recordAudit('register_pending', created.id, request.createdBy ?? null)
    return created
  }

  getById(id: PlatformUserId): Promise<PlatformUser | undefined> {
    return Promise.resolve(this.users.get(id))
  }

  getByAuthSubject(authSubject: string): Promise<PlatformUser | undefined> {
    return Promise.resolve([...this.users.values()].find(entry => entry.authSubject === authSubject))
  }

  list(_request?: PlatformUserListRequest): Promise<readonly PlatformUser[]> {
    return Promise.resolve([...this.users.values()])
  }

  async approve(id: PlatformUserId, request: PlatformUserApproval): Promise<PlatformUser> {
    const approved = user({
      ...(this.users.get(id) as PlatformUser),
      status: 'active',
      platformRoles: request.platformRoles,
      approvedBy: request.approvedBy,
      approvedAt: '2026-08-19T01:00:00.000Z',
    })
    this.users.set(id, approved)
    this.recordAudit('approve', id, request.approvedBy)
    return approved
  }

  async setRoles(id: PlatformUserId, request: PlatformUserRoleUpdate): Promise<PlatformUser> {
    const updated = user({
      ...(this.users.get(id) as PlatformUser),
      platformRoles: request.platformRoles,
    })
    this.users.set(id, updated)
    this.recordAudit('set_roles', id, request.changedBy)
    return updated
  }

  async disable(id: PlatformUserId, request: PlatformUserDisable): Promise<PlatformUser> {
    const updated = user({
      ...(this.users.get(id) as PlatformUser),
      status: 'disabled',
      disabledBy: request.disabledBy,
      ...(request.reason === undefined ? {} : { disabledReason: request.reason }),
      disabledAt: '2026-08-19T02:00:00.000Z',
    })
    this.users.set(id, updated)
    this.recordAudit('disable', id, request.disabledBy)
    return updated
  }

  async lock(id: PlatformUserId, request: PlatformUserLock): Promise<PlatformUser> {
    const updated = user({
      ...(this.users.get(id) as PlatformUser),
      status: 'locked',
      lockedBy: request.lockedBy,
      ...(request.reason === undefined ? {} : { lockedReason: request.reason }),
      lockedAt: '2026-08-19T03:00:00.000Z',
    })
    this.users.set(id, updated)
    this.recordAudit('lock', id, request.lockedBy)
    return updated
  }

  async restore(id: PlatformUserId, request: PlatformUserRestore): Promise<PlatformUser> {
    const existing = this.users.get(id) as PlatformUser
    const restored: PlatformUser = {
      ...existing,
      status: 'active',
      approvedBy: request.restoredBy,
    }
    delete (restored as Partial<PlatformUser>).disabledAt
    delete (restored as Partial<PlatformUser>).disabledBy
    delete (restored as Partial<PlatformUser>).disabledReason
    delete (restored as Partial<PlatformUser>).lockedAt
    delete (restored as Partial<PlatformUser>).lockedBy
    delete (restored as Partial<PlatformUser>).lockedReason
    this.users.set(id, restored)
    this.recordAudit('restore', id, request.restoredBy)
    return restored
  }

  async signUp(email: string, _password: string, loginName: string, displayName: string): Promise<PlatformUser> {
    const authSubject = `auth-${this.nextAuthId++}`
    return await this.registerPendingUser({ authSubject, loginName, displayName, email })
  }

  async signIn(email: string, _password: string): Promise<AuthSignInResult> {
    const platformUser = [...this.users.values()].find(entry => entry.email === email)
    if (platformUser === undefined) {
      throw new PlatformUserError('platform user not found', 'UNKNOWN_USER')
    }
    const accessToken = `token-${this.nextAuthId++}`
    this.tokenToUserId.set(accessToken, platformUser.authSubject)
    return { accessToken, platformUser }
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    const authSubject = this.tokenToUserId.get(accessToken)
    if (authSubject === undefined) {
      throw new PlatformUserError('invalid token', 'AUTH_TOKEN_INVALID')
    }
    const platformUser = [...this.users.values()].find(entry => entry.authSubject === authSubject)
    if (platformUser === undefined) {
      throw new PlatformUserError('platform user not found', 'UNKNOWN_USER')
    }
    return platformUser
  }

  async listAuditEvents(limit?: number): Promise<readonly AuditEvent[]> {
    const events = [...this.auditEvents].reverse()
    return limit !== undefined ? events.slice(0, limit) : events
  }

  private recordAudit(eventType: AuditEventType, targetUserId: PlatformUserId, operatorId: PlatformUserId | null): void {
    this.auditEvents.push({
      id: `audit-${this.auditEvents.length + 1}`,
      eventType,
      targetUserId,
      operatorId,
      details: {},
      createdAt: new Date().toISOString(),
    })
  }
}

async function setup(provider = new StubProvider([user()])): Promise<{ ctx: Context; provider: StubProvider }> {
  const ctx = new Context()
  await ctx.plugin(PlatformUserService)
  ctx.platformUsers.registerProvider(provider)
  return { ctx, provider }
}

describe('dsh-platform-user', () => {
  it('rejects calls before any provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(PlatformUserService)
    await expect(ctx.platformUsers.list()).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects duplicate providers', async () => {
    const ctx = new Context()
    await ctx.plugin(PlatformUserService)
    ctx.platformUsers.registerProvider(new StubProvider())
    expect(() => ctx.platformUsers.registerProvider(new StubProvider())).toThrowError(PlatformUserError)
  })

  it('approves only pending users and normalizes the granted role set', async () => {
    const { ctx, provider } = await setup()
    const approved = await ctx.platformUsers.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: ['normal_user', 'app_admin'],
    })
    expect(approved.status).toBe('active')
    expect(approved.platformRoles).toEqual(['normal_user', 'app_admin'])
    expect(provider.users.get('user-1' as PlatformUserId)?.platformRoles).toEqual(['normal_user', 'app_admin'])
  })

  it('rejects duplicate roles in approval or role updates', async () => {
    const { ctx } = await setup()
    const duplicated = ['normal_user', 'normal_user'] as readonly PlatformRole[]
    await expect(ctx.platformUsers.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: duplicated,
    })).rejects.toMatchObject({ code: 'DUPLICATE_ROLE' })
    await expect(ctx.platformUsers.setRoles('user-1' as PlatformUserId, {
      changedBy: 'admin-1' as PlatformUserId,
      platformRoles: duplicated,
    })).rejects.toMatchObject({ code: 'DUPLICATE_ROLE' })
  })

  it('rejects invalid approval and restore transitions', async () => {
    const { ctx } = await setup(new StubProvider([
      user({ status: 'active', platformRoles: ['normal_user'] }),
    ]))
    await expect(ctx.platformUsers.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: ['normal_user'],
    })).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' })
    await expect(ctx.platformUsers.restore('user-1' as PlatformUserId, {
      restoredBy: 'admin-1' as PlatformUserId,
    })).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' })
  })

  it('restores disabled and locked users back to active', async () => {
    const disabled = await setup(new StubProvider([
      user({ status: 'disabled', disabledBy: 'admin-1' as PlatformUserId }),
    ]))
    await expect(disabled.ctx.platformUsers.restore('user-1' as PlatformUserId, {
      restoredBy: 'admin-2' as PlatformUserId,
    })).resolves.toMatchObject({ status: 'active' })

    const locked = await setup(new StubProvider([
      user({ status: 'locked', lockedBy: 'admin-1' as PlatformUserId }),
    ]))
    await expect(locked.ctx.platformUsers.restore('user-1' as PlatformUserId, {
      restoredBy: 'admin-2' as PlatformUserId,
    })).resolves.toMatchObject({ status: 'active' })
  })

  it('signs up a user and records an audit event', async () => {
    const { ctx, provider } = await setup(new StubProvider())
    const created = await ctx.platformUsers.signUp('bob@example.com', 'pw', 'bob', 'Bob')
    expect(created.status).toBe('pending_approval')
    expect(created.email).toBe('bob@example.com')
    expect(provider.auditEvents).toHaveLength(1)
    expect(provider.auditEvents[0]?.eventType).toBe('register_pending')
  })

  it('signs in and resolves a user by token', async () => {
    const { ctx } = await setup(new StubProvider([
      user({ email: 'alice@example.com', authSubject: 'auth-1' }),
    ]))
    const result = await ctx.platformUsers.signIn('alice@example.com', 'pw')
    expect(result.accessToken.length).toBeGreaterThan(0)
    expect(result.platformUser.email).toBe('alice@example.com')
    const resolved = await ctx.platformUsers.getUserByToken(result.accessToken)
    expect(resolved.email).toBe('alice@example.com')
  })

  it('records audit events for each governance operation', async () => {
    const { ctx } = await setup(new StubProvider([
      user({ status: 'pending_approval' }),
    ]))
    await ctx.platformUsers.approve('user-1' as PlatformUserId, {
      approvedBy: 'admin-1' as PlatformUserId,
      platformRoles: ['normal_user'],
    })
    await ctx.platformUsers.setRoles('user-1' as PlatformUserId, {
      changedBy: 'admin-2' as PlatformUserId,
      platformRoles: ['app_admin'],
    })
    await ctx.platformUsers.disable('user-1' as PlatformUserId, {
      disabledBy: 'admin-3' as PlatformUserId,
    })
    await ctx.platformUsers.restore('user-1' as PlatformUserId, {
      restoredBy: 'admin-4' as PlatformUserId,
    })
    const events = await ctx.platformUsers.listAuditEvents()
    const types = events.map(e => e.eventType)
    expect(types).toEqual(['restore', 'disable', 'set_roles', 'approve'])
    const limited = await ctx.platformUsers.listAuditEvents(2)
    expect(limited).toHaveLength(2)
    expect(limited[0]?.eventType).toBe('restore')
  })
})
