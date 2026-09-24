import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as UserInvariant from '../src/invariant.ts'
import { renderIdentityText } from '../src/text.ts'
import { platformUser } from './helpers.ts'

const SECOND = Date.parse('2026-07-14T00:00:00Z')
const BLOCK_TEXT = renderIdentityText(platformUser())

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(UserInvariant)
  return ctx
}

function event(
  text: string,
  time = SECOND + 456,
  content?: unknown[],
  plugin = 'user-identity-context',
): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    surfaceOp: 'append',
    data: createUserMessage({
      content: (content ?? [{ type: 'text', text }]) as ContentBlock[],
      source: plugin === 'user-identity-context'
        ? {
          kind: 'plugin',
          plugin,
          form: 'snapshot',
          sections: [{ name: plugin, text }],
        }
        : { kind: 'plugin', plugin },
    }),
  }
}

function preparing(turn: number, step: number): Session {
  const session = Session.create(SessionId(`identity-invariant-${turn}-${step}`))
  for (let priorTurn = 1; priorTurn < turn; priorTurn += 1) {
    session.append('turn/start', { turn: priorTurn })
    session.append('turn/end', { turn: priorTurn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let priorStep = 1; priorStep < step; priorStep += 1) {
    session.append('step/start', { turn, step: priorStep })
    session.append('step/end', { turn, step: priorStep })
  }
  session.append('step/start', { turn, step })
  return session
}

function appendBlock(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'user-identity-context',
      form: 'snapshot',
      sections: [{ name: 'user-identity-context', text }],
    },
  }), { surfaceOp: 'append' })
}

describe('user-identity-context invariants', () => {
  it('accepts a well-formed block inside an open step', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(BLOCK_TEXT)) }).not.toThrow()
  })

  it('accepts a block carrying the optional org-positions section', async () => {
    const ctx = await setup()
    const withPositions = renderIdentityText(platformUser(), [
      { orgUnitId: 'unit-a', orgUnitName: 'A 部门', pathToRoot: ['总公司', 'A 部门'] },
    ])
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(withPositions)) }).not.toThrow()
  })

  it('accepts a block carrying the optional auth-token section', async () => {
    const ctx = await setup()
    const withToken = renderIdentityText(platformUser(), [], 'jwt-a')
    expect(withToken).toContain('认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：\njwt-a\n')
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(withToken)) }).not.toThrow()
  })

  it('accepts a block carrying both the auth-token and org-positions sections', async () => {
    const ctx = await setup()
    const withBoth = renderIdentityText(platformUser(), [
      { orgUnitId: 'unit-a', orgUnitName: 'A 部门', pathToRoot: ['总公司', 'A 部门'] },
    ], 'jwt-a')
    expect(withBoth.indexOf('认证令牌')).toBeLessThan(withBoth.indexOf('组织身份'))
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(withBoth)) }).not.toThrow()
  })

  it('accepts a well-formed block at a later step of an open turn', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(BLOCK_TEXT)) }).not.toThrow()
  })

  it('rejects a block that does not match the durable identity format', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(1, 1), event('<user_identity>\n被改写过的身份块')) })
      .toThrow(/durable identity format/)
  })

  it('rejects blank identity fields', async () => {
    const ctx = await setup()
    const blank = renderIdentityText(platformUser({ displayName: ' ' }))
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(blank)) })
      .toThrow(/non-blank/)
  })

  it('rejects a block outside prompt assembly', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', Session.create(SessionId('identity-invariant-empty')), event(BLOCK_TEXT))
    }).toThrow(/inside an open turn/)

    const noStep = Session.create(SessionId('identity-invariant-turn-only'))
    noStep.append('turn/start', { turn: 1 })
    expect(() => { ctx.emit('session/event', noStep, event(BLOCK_TEXT)) }).toThrow(/follow step\/start/)

    const ended = preparing(1, 1)
    ended.append('step/end', { turn: 1, step: 1 })
    expect(() => { ctx.emit('session/event', ended, event(BLOCK_TEXT)) }).toThrow(/follow step\/start/)

    const requested = preparing(1, 1)
    requested.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    expect(() => { ctx.emit('session/event', requested, event(BLOCK_TEXT)) }).toThrow(/precede request\/header/)
  })

  it('rejects a block after the turn closes', async () => {
    const ctx = await setup()
    const session = preparing(1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => { ctx.emit('session/event', session, event(BLOCK_TEXT)) })
      .toThrow(/inside an open turn/)
  })

  it('requires exactly one text block', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(1, 1), event('ignored', SECOND, [])) })
      .toThrow(/exactly one text block/)
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), event('ignored', SECOND, [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]))
    }).toThrow(/exactly one text block/)
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), event('ignored', SECOND, [
        { type: 'text', text: BLOCK_TEXT, extra: true },
      ]))
    }).toThrow(/exactly one text block/)
  })

  it('requires exact snapshot provenance without copied request authority', async () => {
    const ctx = await setup()
    const base = event(BLOCK_TEXT)
    for (const source of [
      { kind: 'plugin', plugin: 'user-identity-context' },
      { ...base.data.source, authority: {} },
      {
        kind: 'plugin',
        plugin: 'user-identity-context',
        form: 'snapshot',
        sections: [{ name: 'user-identity-context', text: 'different' }],
      },
      {
        kind: 'plugin',
        plugin: 'user-identity-context',
        form: 'snapshot',
        sections: { 0: { name: 'user-identity-context', text: BLOCK_TEXT }, length: 1 },
      },
      {
        kind: 'plugin',
        plugin: 'user-identity-context',
        form: 'snapshot',
        sections: [{ name: 'user-identity-context', text: BLOCK_TEXT, extra: true }],
      },
    ]) {
      const malformed: SessionEvent<'user/message'> = {
        ...base,
        data: { ...base.data, source: source as never },
      }
      expect(() => { ctx.emit('session/event', preparing(1, 1), malformed) })
        .toThrow(/must carry only the exact snapshot text/)
    }
  })

  it('validates existing blocks against their durable prefix at late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('identity-invariant-late-valid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendBlock(session, BLOCK_TEXT)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserInvariant)).resolves.toBeDefined()
  })

  it('rejects an invalid existing block on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('identity-invariant-late-invalid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendBlock(session, '<user_identity>\n被改写过的身份块')

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserInvariant).then(() => undefined)).rejects.toThrow(/durable identity format/)
  })

  it('ignores context messages owned by another package', async () => {
    const ctx = await setup()
    const other = event('unrelated', SECOND + 456, undefined, 'other')
    expect(() => { ctx.emit('session/event', preparing(1, 1), other) }).not.toThrow()
    const user: SessionEvent<'user/message'> = {
      ...event('unrelated'),
      data: createUserMessage({
        content: [{ type: 'text', text: 'unrelated' }],
        source: { kind: 'user' },
      }),
    }
    expect(() => { ctx.emit('session/event', preparing(1, 1), user) }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), {
        type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 },
      })
      ctx.emit('tools/change')
    }).not.toThrow()
  })
})
