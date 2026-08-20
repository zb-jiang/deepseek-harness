/**
 * Service Definition for platform-user governance (`ctx.platformUsers`): register,
 * approve, look up, and administratively change enterprise platform users.
 * Auth itself stays in the external identity backend; this seam owns the
 * Harness-side governance record layered on top.
 *
 * @module @deepseek-ai/dsh-platform-user
 */

import { Context, Service } from '@deepseek-ai/cordis'

import type {
  AuditEvent,
  AuthSignInResult,
  PlatformRole,
  PlatformUser,
  PlatformUserApproval,
  PlatformUserDisable,
  PlatformUserId,
  PlatformUserListRequest,
  PlatformUserLock,
  PlatformUserRegistration,
  PlatformUserRestore,
  PlatformUserRoleUpdate,
  PlatformUserStatus,
} from './types.ts'

export type {
  AuditEvent,
  AuditEventType,
  AuthSignInResult,
  PlatformRole,
  PlatformUser,
  PlatformUserApproval,
  PlatformUserDisable,
  PlatformUserId,
  PlatformUserListRequest,
  PlatformUserLock,
  PlatformUserRegistration,
  PlatformUserRestore,
  PlatformUserRoleUpdate,
  PlatformUserStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    platformUsers: PlatformUserService
  }
}

const PLATFORM_ROLES: readonly PlatformRole[] = ['system_admin', 'app_admin', 'normal_user']

/** One provider implementation of the platform-user seam. */
export interface PlatformUserProvider {
  /**
   * Create a new pending platform user record.
   * @param request - registration request mapped from the auth backend.
   * @returns the created pending record.
   */
  registerPendingUser(request: PlatformUserRegistration): Promise<PlatformUser>
  /**
   * Read one user by platform user id.
   * @param id - durable platform user id.
   * @returns the record when it exists.
   */
  getById(id: PlatformUserId): Promise<PlatformUser | undefined>
  /**
   * Read one user by external auth subject.
   * @param authSubject - auth-backend subject id.
   * @returns the record when it exists.
   */
  getByAuthSubject(authSubject: string): Promise<PlatformUser | undefined>
  /**
   * List users under one optional filter.
   * @param request - optional list filter.
   * @returns matching users in provider-defined order.
   */
  list(request?: PlatformUserListRequest): Promise<readonly PlatformUser[]>
  /**
   * Approve one pending user and write its initial role set.
   * @param id - durable platform user id.
   * @param request - approval command.
   * @returns the updated active record.
   */
  approve(id: PlatformUserId, request: PlatformUserApproval): Promise<PlatformUser>
  /**
   * Replace the role set of an existing user.
   * @param id - durable platform user id.
   * @param request - full next role set.
   * @returns the updated record.
   */
  setRoles(id: PlatformUserId, request: PlatformUserRoleUpdate): Promise<PlatformUser>
  /**
   * Disable one user.
   * @param id - durable platform user id.
   * @param request - disable command.
   * @returns the updated record.
   */
  disable(id: PlatformUserId, request: PlatformUserDisable): Promise<PlatformUser>
  /**
   * Lock one user.
   * @param id - durable platform user id.
   * @param request - lock command.
   * @returns the updated record.
   */
  lock(id: PlatformUserId, request: PlatformUserLock): Promise<PlatformUser>
  /**
   * Restore one disabled or locked user back to active.
   * @param id - durable platform user id.
   * @param request - restore command.
   * @returns the updated record.
   */
  restore(id: PlatformUserId, request: PlatformUserRestore): Promise<PlatformUser>
  /**
   * Register a new user through the auth backend, then create a pending
   * platform user record.
   * @param email - user email address.
   * @param password - user-chosen password.
   * @param loginName - requested platform login name.
   * @param displayName - human-readable display name.
   * @returns the created pending record.
   */
  signUp(email: string, password: string, loginName: string, displayName: string): Promise<PlatformUser>
  /**
   * Authenticate a user and return an access token plus the platform record.
   * @param email - user email address.
   * @param password - user password.
   * @returns access token and platform user record.
   */
  signIn(email: string, password: string): Promise<AuthSignInResult>
  /**
   * Resolve a platform user from an access token.
   * @param accessToken - access token from the auth backend.
   * @returns the platform user record.
   */
  getUserByToken(accessToken: string): Promise<PlatformUser>
  /**
   * List audit events recording governance operations.
   * @param limit - maximum number of events to return.
   * @returns matching audit events in descending creation order.
   */
  listAuditEvents(limit?: number): Promise<readonly AuditEvent[]>
}

/** Stable error taxonomy for platform-user failures. */
export class PlatformUserError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PlatformUserError'
  }
}

function assertKnownRole(role: string): asserts role is PlatformRole {
  if (!PLATFORM_ROLES.includes(role as PlatformRole)) {
    throw new PlatformUserError(`unknown platform role "${role}"`, 'INVALID_ROLE')
  }
}

function normalizeRoleSet(roles: readonly PlatformRole[]): readonly PlatformRole[] {
  const unique = new Set<PlatformRole>()
  for (const role of roles) {
    assertKnownRole(role)
    if (unique.has(role)) {
      throw new PlatformUserError(`duplicate platform role "${role}"`, 'DUPLICATE_ROLE')
    }
    unique.add(role)
  }
  return [...unique]
}

/** `ctx.platformUsers`: one active provider plus governance operations. */
export class PlatformUserService extends Service {
  private provider: PlatformUserProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'platformUsers')
  }

  /**
   * Register the active provider. Only one provider may be mounted.
   * @param provider - provider implementation.
   * @returns disposer that unregisters it.
   */
  registerProvider(provider: PlatformUserProvider): () => void {
    const dispose = this.ctx.effect(function* (this: PlatformUserService) {
      if (this.provider !== undefined) {
        throw new PlatformUserError('a platform-user provider is already registered', 'DUPLICATE_PROVIDER')
      }
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'platformUsers.registerProvider()')
    return () => void dispose()
  }

  /**
   * Create a new pending user.
   * @param request - registration request from the auth flow.
   * @returns the created pending record.
   */
  registerPendingUser(request: PlatformUserRegistration): Promise<PlatformUser> {
    return this.requireProvider().registerPendingUser(request)
  }

  /**
   * Read one user by id.
   * @param id - platform user id.
   * @returns the record when it exists.
   */
  getById(id: PlatformUserId): Promise<PlatformUser | undefined> {
    return this.requireProvider().getById(id)
  }

  /**
   * Read one user by external auth subject.
   * @param authSubject - auth-backend subject id.
   * @returns the record when it exists.
   */
  getByAuthSubject(authSubject: string): Promise<PlatformUser | undefined> {
    return this.requireProvider().getByAuthSubject(authSubject)
  }

  /**
   * List users under one optional filter.
   * @param request - optional filter.
   * @returns matching users in provider-defined order.
   */
  async list(request?: PlatformUserListRequest): Promise<readonly PlatformUser[]> {
    if (request?.statuses !== undefined) {
      for (const status of request.statuses) assertKnownStatus(status)
    }
    if (request?.role !== undefined) assertKnownRole(request.role)
    return await this.requireProvider().list(request)
  }

  /**
   * Approve a pending user and set its initial role set.
   * @param id - platform user id.
   * @param request - approval command.
   * @returns the approved active record.
   */
  async approve(id: PlatformUserId, request: PlatformUserApproval): Promise<PlatformUser> {
    const current = await this.requireUser(id)
    if (current.status !== 'pending_approval') {
      throw new PlatformUserError(
        `only a pending user can be approved; "${id}" is "${current.status}"`,
        'INVALID_STATUS_TRANSITION',
      )
    }
    return await this.requireProvider().approve(id, {
      ...request,
      platformRoles: normalizeRoleSet(request.platformRoles),
    })
  }

  /**
   * Replace the current role set of one user.
   * @param id - platform user id.
   * @param request - full next role set.
   * @returns the updated record.
   */
  async setRoles(id: PlatformUserId, request: PlatformUserRoleUpdate): Promise<PlatformUser> {
    await this.requireUser(id)
    return await this.requireProvider().setRoles(id, {
      ...request,
      platformRoles: normalizeRoleSet(request.platformRoles),
    })
  }

  /**
   * Disable one user.
   * @param id - platform user id.
   * @param request - disable command.
   * @returns the updated record.
   */
  async disable(id: PlatformUserId, request: PlatformUserDisable): Promise<PlatformUser> {
    const current = await this.requireUser(id)
    if (current.status === 'disabled') {
      throw new PlatformUserError(`user "${id}" is already disabled`, 'INVALID_STATUS_TRANSITION')
    }
    return await this.requireProvider().disable(id, request)
  }

  /**
   * Lock one user.
   * @param id - platform user id.
   * @param request - lock command.
   * @returns the updated record.
   */
  async lock(id: PlatformUserId, request: PlatformUserLock): Promise<PlatformUser> {
    const current = await this.requireUser(id)
    if (current.status === 'locked') {
      throw new PlatformUserError(`user "${id}" is already locked`, 'INVALID_STATUS_TRANSITION')
    }
    return await this.requireProvider().lock(id, request)
  }

  /**
   * Restore a disabled or locked user back to active.
   * @param id - platform user id.
   * @param request - restore command.
   * @returns the restored active record.
   */
  async restore(id: PlatformUserId, request: PlatformUserRestore): Promise<PlatformUser> {
    const current = await this.requireUser(id)
    if (current.status !== 'disabled' && current.status !== 'locked') {
      throw new PlatformUserError(
        `only a disabled or locked user can be restored; "${id}" is "${current.status}"`,
        'INVALID_STATUS_TRANSITION',
      )
    }
    return await this.requireProvider().restore(id, request)
  }

  /**
   * Register a new user through the auth backend.
   * @param email - user email address.
   * @param password - user-chosen password.
   * @param loginName - requested platform login name.
   * @param displayName - human-readable display name.
   * @returns the created pending record.
   */
  signUp(email: string, password: string, loginName: string, displayName: string): Promise<PlatformUser> {
    return this.requireProvider().signUp(email, password, loginName, displayName)
  }

  /**
   * Authenticate a user and return an access token plus the platform record.
   * @param email - user email address.
   * @param password - user password.
   * @returns access token and platform user record.
   */
  signIn(email: string, password: string): Promise<AuthSignInResult> {
    return this.requireProvider().signIn(email, password)
  }

  /**
   * Resolve a platform user from an access token.
   * @param accessToken - access token from the auth backend.
   * @returns the platform user record.
   */
  getUserByToken(accessToken: string): Promise<PlatformUser> {
    return this.requireProvider().getUserByToken(accessToken)
  }

  /**
   * List audit events recording governance operations.
   * @param limit - maximum number of events to return.
   * @returns matching audit events in descending creation order.
   */
  listAuditEvents(limit?: number): Promise<readonly AuditEvent[]> {
    return this.requireProvider().listAuditEvents(limit)
  }

  private requireProvider(): PlatformUserProvider {
    if (this.provider === undefined) {
      throw new PlatformUserError('no platform-user provider is registered', 'NO_PROVIDER')
    }
    return this.provider
  }

  private async requireUser(id: PlatformUserId): Promise<PlatformUser> {
    const user = await this.requireProvider().getById(id)
    if (user === undefined) {
      throw new PlatformUserError(`unknown platform user "${id}"`, 'UNKNOWN_USER')
    }
    return user
  }
}

function assertKnownStatus(status: string): asserts status is PlatformUserStatus {
  if (!['pending_approval', 'active', 'disabled', 'locked'].includes(status)) {
    throw new PlatformUserError(`unknown platform user status "${status}"`, 'INVALID_STATUS')
  }
}

export default PlatformUserService
