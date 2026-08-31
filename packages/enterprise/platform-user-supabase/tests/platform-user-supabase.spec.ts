import { describe, expect, it } from 'vitest'
import type { PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import {
  mapPlatformUser,
  readPlatformUserRow,
  resolveConfig,
  type PlatformUserRow,
} from '../src/index.ts'

const row = (overrides: Partial<PlatformUserRow> = {}): PlatformUserRow => ({
  id: 'user-1',
  auth_subject: 'auth-1',
  login_name: 'alice',
  display_name: 'Alice',
  email: 'alice@example.com',
  status: 'pending_approval',
  platform_roles: [],
  created_at: '2026-08-30T00:00:00.000Z',
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

describe('dsh-platform-user-supabase', () => {
  it('resolves config with defaults and rejects empty required fields', () => {
    expect(resolveConfig({
      url: 'https://example.supabase.co',
      anonKey: 'anon-secret',
    })).toEqual({
      url: 'https://example.supabase.co',
      anonKey: 'anon-secret',
      usersTable: 'platform_users',
    })
    expect(() => resolveConfig({
      url: '',
      anonKey: 'anon-secret',
    })).toThrow('url must be a non-empty string')
    expect(() => resolveConfig({
      url: 'https://example.supabase.co',
      anonKey: '',
    })).toThrow('anonKey must be a non-empty string')
  })

  it('validates and maps a minimal row', () => {
    const validated = readPlatformUserRow(row())
    expect(mapPlatformUser(validated)).toEqual({
      id: 'user-1' as PlatformUserId,
      authSubject: 'auth-1',
      loginName: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'pending_approval',
      platformRoles: [],
      createdAt: '2026-08-30T00:00:00.000Z',
    })
  })

  it('maps an active row with approval metadata', () => {
    const validated = readPlatformUserRow(row({
      status: 'active',
      platform_roles: ['normal_user', 'app_admin'],
      approved_by: 'admin-1',
      approved_at: '2026-08-30T01:00:00.000Z',
    }))
    const mapped = mapPlatformUser(validated)
    expect(mapped.status).toBe('active')
    expect(mapped.platformRoles).toEqual(['normal_user', 'app_admin'])
    expect(mapped.approvedBy).toBe('admin-1' as PlatformUserId)
    expect(mapped.approvedAt).toBe('2026-08-30T01:00:00.000Z')
  })

  it('maps a disabled row with reason', () => {
    const validated = readPlatformUserRow(row({
      status: 'disabled',
      disabled_by: 'admin-2',
      disabled_at: '2026-08-30T02:00:00.000Z',
      disabled_reason: 'left company',
    }))
    const mapped = mapPlatformUser(validated)
    expect(mapped.status).toBe('disabled')
    expect(mapped.disabledBy).toBe('admin-2' as PlatformUserId)
    expect(mapped.disabledReason).toBe('left company')
  })

  it('rejects an unknown status', () => {
    expect(() => readPlatformUserRow(row({ status: 'bogus' as PlatformUserRow['status'] }))).toThrow('unknown platform user status')
  })

  it('rejects an unknown role', () => {
    expect(() => readPlatformUserRow(row({ platform_roles: ['super_admin'] as unknown[] as PlatformUserRow['platform_roles'] }))).toThrow('unknown platform role')
  })

  it('rejects a non-object row', () => {
    expect(() => readPlatformUserRow(null)).toThrow('a user row must be an object')
    expect(() => readPlatformUserRow([])).toThrow('a user row must be an object')
  })
})
