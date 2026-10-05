import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as KbInvariant from '../src/invariant.ts'
import { renderKbContextText } from '../src/text.ts'

const SECOND = Date.parse('2026-07-14T00:00:00Z')
const BLOCK_TEXT = renderKbContextText({ kbId: 'kb-1', kbName: '财务制度库' })

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(KbInvariant)
  return ctx
}

function event(
  text: string,
  time = SECOND + 456,
  content?: unknown[],
  owner: 'kb-context' | 'other' = 'kb-context',
): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    surfaceOp: 'append',
    data: createUserMessage({
      content: (content ?? [{ type: 'text', text }]) as ContentBlock[],
      source: owner === 'kb-context'
        ? {
          kind: 'kb-context',
          form: 'snapshot',
          sections: [{ name: owner, text }],
        }
        : { kind: 'user' },
    }),
  }
}

function preparing(turn: number, step: number): Session {
  const session = Session.create(SessionId(`kb-invariant-${turn}-${step}`))
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
      kind: 'kb-context',
      form: 'snapshot',
      sections: [{ name: 'kb-context', text }],
    },
  }), { surfaceOp: 'append' })
}

describe('kb-context invariants', () => {
  it('accepts a well-formed block inside an open step', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(BLOCK_TEXT)) }).not.toThrow()
  })

  it('accepts a well-formed block at a later step of an open turn', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(BLOCK_TEXT)) }).not.toThrow()
  })

  it('rejects a block that does not match the durable knowledge-base format', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(1, 1), event('<knowledge_base>\n被改写过的知识库块')) })
      .toThrow(/durable knowledge-base format/)
  })

  it('rejects blank kb fields', async () => {
    const ctx = await setup()
    const blank = renderKbContextText({ kbId: 'kb-1', kbName: ' ' })
    expect(() => { ctx.emit('session/event', preparing(1, 1), event(blank)) })
      .toThrow(/non-blank/)
  })

  it('rejects a block outside prompt assembly', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', Session.create(SessionId('kb-invariant-empty')), event(BLOCK_TEXT))
    }).toThrow(/inside an open turn/)

    const noStep = Session.create(SessionId('kb-invariant-turn-only'))
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

  it('requires an exactly-sourced snapshot without copied request authority', async () => {
    const ctx = await setup()
    const base = event(BLOCK_TEXT)
    for (const source of [
      { kind: 'kb-context' },
      { ...base.data.source, authority: {} },
      {
        kind: 'kb-context',
        form: 'snapshot',
        sections: [{ name: 'kb-context', text: 'different' }],
      },
      {
        kind: 'kb-context',
        form: 'snapshot',
        sections: { 0: { name: 'kb-context', text: BLOCK_TEXT }, length: 1 },
      },
      {
        kind: 'kb-context',
        form: 'snapshot',
        sections: [{ name: 'kb-context', text: BLOCK_TEXT, extra: true }],
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

  it('validates existing blocks against their durable format at late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('kb-invariant-late-valid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendBlock(session, BLOCK_TEXT)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(KbInvariant)).resolves.toBeDefined()
  })

  it('rejects an invalid existing block on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('kb-invariant-late-invalid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendBlock(session, '<knowledge_base>\n被改写过的知识库块')

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(KbInvariant).then(() => undefined)).rejects.toThrow(/durable knowledge-base format/)
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
