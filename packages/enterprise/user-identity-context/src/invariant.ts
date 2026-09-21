/** Package-owned session-identity invariants. @module @deepseek-ai/dsh-user-identity-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { IDENTITY_DISCIPLINE, ORG_POSITIONS_HEADER, USER_IDENTITY_SECTION } from './text.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-identity-context'
const SOURCE_NAME = 'user-identity-context'
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BLOCK = new RegExp(
  '^<user_identity>\\n'
  + '当前登录人：(.+)（(.+)）\\n'
  + 'userId: (.+)\\n'
  // 组织身份段可选(未登录拉取失败/组织维度未启用时不渲染),有则至少一条
  + '(?:' + escapeRegExp(ORG_POSITIONS_HEADER) + '\\n(?:- .+\\n)+)?'
  + escapeRegExp(IDENTITY_DISCIPLINE)
  + '\\n</user_identity>$',
)

/** Cordis companion plugin name. */
export const name = 'user-identity-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'] as const

/** Derive the open step boundary at which an identity block may append. */
function preparationPosition(history: readonly SessionEvent[], fail: InvariantFailure): void {
  let openTurn: number | undefined
  let openStep: number | undefined
  let requestStarted = false
  for (const event of history) {
    switch (event.type) {
      case 'turn/start': {
        openTurn = event.data.turn
        openStep = undefined
        requestStarted = false
        break
      }
      case 'step/start': {
        openStep = event.data.step
        requestStarted = false
        break
      }
      case 'request/header': {
        requestStarted = true
        break
      }
      case 'step/end': {
        openStep = undefined
        requestStarted = false
        break
      }
      case 'turn/end': {
        openTurn = undefined
        openStep = undefined
        requestStarted = false
        break
      }
      default:
        break
    }
  }
  if (openTurn === undefined) fail('user-identity block must be appended inside an open turn')
  if (openStep === undefined) fail('user-identity block must follow step/start')
  if (requestStarted) fail('user-identity block must precede request/header')
}

/** Validate one plugin-attributed identity block against its format and session position. */
function validateReading(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const blockValue: unknown = event.data.content[0]
  const block = typeof blockValue === 'object' && blockValue !== null
    ? blockValue as Record<string, unknown>
    : undefined
  const blockText = block?.text
  if (event.data.content.length !== 1
    || block === undefined
    || Object.keys(block).length !== 2
    || block.type !== 'text'
    || typeof blockText !== 'string') {
    fail('user-identity messages must contain exactly one text block')
  }
  const match = BLOCK.exec(blockText)
  if (match === null) fail('user-identity block does not match the durable identity format')
  if (match.slice(1).some(field => field.trim().length === 0)) {
    fail('user-identity fields must be non-blank')
  }
  preparationPosition(history, fail)
  const source = event.data.source
  /* v8 ignore next 2 -- replay and dispatch callers select this exact package-owned source before validation. */
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('user-identity source must retain package ownership')
  }
  const sections: unknown = 'sections' in source ? source.sections : undefined
  const sectionValue: unknown = Array.isArray(sections) ? sections[0] : undefined
  const section = typeof sectionValue === 'object' && sectionValue !== null
    ? sectionValue as Record<string, unknown>
    : undefined
  if (Object.keys(source).length !== 4
    || source.form !== 'snapshot'
    || !Array.isArray(sections)
    || sections.length !== 1
    || section === undefined
    || Object.keys(section).length !== 2
    || section.name !== USER_IDENTITY_SECTION
    || section.text !== blockText) {
    fail('user-identity source must carry only the exact snapshot text, not request authority')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate all package-owned identity blocks already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  const history = session.snapshotEvents()
  for (const [index, event] of history.entries()) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateReading(history.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended identity blocks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateReading(session.snapshotEvents(), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the user-identity-context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
