import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import PlatformUserService, {
  PlatformUserError,
  type PlatformUser,
  type PlatformUserId,
  type PlatformUserProvider,
} from '../src/index.ts'

const user = (overrides: Partial<PlatformUser> = {}): PlatformUser => ({
  id: 'user-1' as PlatformUserId,
  authSubject: 'auth-1',
  loginName: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  status: 'active',
  platformRoles: ['normal_user'],
  createdAt: '2026-08-30T00:00:00.000Z',
  ...overrides,
})

class StubProvider implements PlatformUserProvider {
  private readonly tokenToUser = new Map<string, PlatformUser>()

  constructor(seed: { token: string; user: PlatformUser }[] = []) {
    for (const { token, user: u } of seed) this.tokenToUser.set(token, u)
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    const found = this.tokenToUser.get(accessToken)
    if (found === undefined) {
      throw new PlatformUserError('invalid token', 'AUTH_TOKEN_INVALID')
    }
    return found
  }
}

async function setup(provider = new StubProvider([{ token: 'valid-token', user: user() }])): Promise<{ ctx: Context; provider: StubProvider }> {
  const ctx = new Context()
  await ctx.plugin(PlatformUserService)
  ctx.platformUsers.registerProvider(provider)
  return { ctx, provider }
}

describe('dsh-platform-user', () => {
  it('rejects getUserByToken before any provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(PlatformUserService)
    await expect(ctx.platformUsers.getUserByToken('any')).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects duplicate providers', async () => {
    const ctx = new Context()
    await ctx.plugin(PlatformUserService)
    ctx.platformUsers.registerProvider(new StubProvider())
    expect(() => ctx.platformUsers.registerProvider(new StubProvider())).toThrowError(PlatformUserError)
  })

  it('resolves a user by valid token', async () => {
    const { ctx } = await setup()
    const resolved = await ctx.platformUsers.getUserByToken('valid-token')
    expect(resolved.email).toBe('alice@example.com')
    expect(resolved.status).toBe('active')
  })

  it('rejects an invalid token', async () => {
    const { ctx } = await setup()
    await expect(ctx.platformUsers.getUserByToken('bogus')).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' })
  })
})
