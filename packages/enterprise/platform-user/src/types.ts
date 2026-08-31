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
