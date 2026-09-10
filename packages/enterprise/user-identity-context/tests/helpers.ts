import type { PlatformUser } from '@deepseek-ai/dsh-platform-user'

/** One complete platform-user record with overridable fields. */
export function platformUser(overrides: Partial<PlatformUser> = {}): PlatformUser {
  return {
    id: 'u-1' as PlatformUser['id'],
    authSubject: 'sub-1',
    loginName: 'zhangsan',
    displayName: '张三',
    email: 'zhangsan@corp.com',
    status: 'active',
    platformRoles: ['normal_user'],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}
