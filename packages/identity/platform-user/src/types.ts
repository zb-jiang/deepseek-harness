/**
 * Types for the platform-user capability seam.
 * @module @deepseek-ai/dsh-platform-user/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id for one platform user record. */
export type PlatformUserId = Branded<'PlatformUserId'>

/** One allowed platform role. */
export type PlatformRole = 'system_admin' | 'app_admin' | 'normal_user'

/** Lifecycle state of a platform user record. */
export type PlatformUserStatus = 'pending_approval' | 'active' | 'disabled' | 'locked'

/** Stored platform user record shared across providers and consumers. */
export interface PlatformUser {
  /** Durable platform user id. */
  id: PlatformUserId
  /** Auth-backend subject id, such as a Supabase auth user id. */
  authSubject: string
  /** Unique platform login name. */
  loginName: string
  /** Human-readable display name. */
  displayName: string
  /** Unique email address. */
  email: string
  /** Current lifecycle state. */
  status: PlatformUserStatus
  /** Current platform roles. */
  platformRoles: readonly PlatformRole[]
  /** Creation timestamp in ISO-8601 form. */
  createdAt: string
  /** Operator who created this record, when it was not self-registration. */
  createdBy?: PlatformUserId
  /** Approval timestamp. */
  approvedAt?: string
  /** Approver id. */
  approvedBy?: PlatformUserId
  /** Disable timestamp. */
  disabledAt?: string
  /** Disabling operator id. */
  disabledBy?: PlatformUserId
  /** Disable reason. */
  disabledReason?: string
  /** Lock timestamp. */
  lockedAt?: string
  /** Locking operator id. */
  lockedBy?: PlatformUserId
  /** Lock reason. */
  lockedReason?: string
}

/** Registration request after an external auth backend has created the subject. */
export interface PlatformUserRegistration {
  /** Auth-backend subject id. */
  authSubject: string
  /** Requested login name. */
  loginName: string
  /** Requested display name. */
  displayName: string
  /** Requested email address. */
  email: string
  /** Operator who created the record, when it was not self-service. */
  createdBy?: PlatformUserId
}

/** Filters for listing platform users. */
export interface PlatformUserListRequest {
  /** Optional lifecycle-state filter. */
  statuses?: readonly PlatformUserStatus[]
  /** Optional exact role-membership filter. */
  role?: PlatformRole
}

/** Approval command for a pending user. */
export interface PlatformUserApproval {
  /** Approver id. */
  approvedBy: PlatformUserId
  /** Roles granted at approval time. */
  platformRoles: readonly PlatformRole[]
}

/** Platform-role update for an existing user. */
export interface PlatformUserRoleUpdate {
  /** Operator who changes the role set. */
  changedBy: PlatformUserId
  /** Complete next role set. */
  platformRoles: readonly PlatformRole[]
}

/** Disable command. */
export interface PlatformUserDisable {
  /** Operator who disables the user. */
  disabledBy: PlatformUserId
  /** Human-readable reason. */
  reason?: string
}

/** Lock command. */
export interface PlatformUserLock {
  /** Operator who locks the user. */
  lockedBy: PlatformUserId
  /** Human-readable reason. */
  reason?: string
}

/** Restore command for a disabled or locked user. */
export interface PlatformUserRestore {
  /** Operator who restores the user. */
  restoredBy: PlatformUserId
}

/** Result of a successful sign-in. */
export interface AuthSignInResult {
  /** Access token for subsequent authenticated requests. */
  accessToken: string
  /** Platform user record associated with the authenticated subject. */
  platformUser: PlatformUser
}

/** Type of governance operation recorded in the audit log. */
export type AuditEventType = 'register_pending' | 'approve' | 'set_roles' | 'disable' | 'lock' | 'restore'

/** One audit log entry recording a governance operation. */
export interface AuditEvent {
  /** Durable audit event id. */
  id: string
  /** Type of governance operation. */
  eventType: AuditEventType
  /** Platform user that was the target of the operation. */
  targetUserId: PlatformUserId
  /** Operator who performed the operation, when not self-service. */
  operatorId: PlatformUserId | null
  /** Operation-specific details. */
  details: Readonly<Record<string, unknown>>
  /** Creation timestamp in ISO-8601 form. */
  createdAt: string
}
