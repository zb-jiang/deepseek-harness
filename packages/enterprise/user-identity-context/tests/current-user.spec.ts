import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as userIdentityContext from '../src/index.ts'
import { platformUser } from './helpers.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(userIdentityContext)
  return ctx
}

describe('current-user store', () => {
  it('mounts ctx.currentUser and remembers the latest verified identity', async () => {
    const ctx = await mount()
    expect(ctx.currentUser.get()).toBeUndefined()

    const first = platformUser()
    ctx.currentUser.observe(first)
    expect(ctx.currentUser.get()).toBe(first)

    const second = platformUser({ authSubject: 'sub-2', displayName: '张经理' })
    ctx.currentUser.observe(second)
    expect(ctx.currentUser.get()).toBe(second)
  })

  it('clear forgets the current identity', async () => {
    const ctx = await mount()
    ctx.currentUser.observe(platformUser())
    expect(ctx.currentUser.get()).toBeDefined()

    ctx.currentUser.clear()
    expect(ctx.currentUser.get()).toBeUndefined()
  })
})
