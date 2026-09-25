/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only. Inline references follow the consumer's wrapping policy and keep long
 * labels within its width. Decoration sources, by precedence: registered
 * decorators ({@link registerUserTextDecorator}) claim exact spans first and
 * shadow the shape scans on shared ranges; the wire session form
 * `@[label](dsh-session:...)` folds to its label; exact session labels
 * supplied by an adjacent recall decorate their bare `@label` mention; plain
 * `@name` word-boundary tokens decorate by shape alone; and a plain `/name`
 * token decorates only when the caller names it — a skill the host actually
 * loaded for that message (ui-chat reads the step's `skill-invocation`
 * injections) or the command a command-input bubble echoes — so `/123` or a
 * stray `/word` stays plain text. A `/name` token is whitespace-bounded like
 * the host skill gesture (`dsh-tool-skill`): it ends at whitespace or the
 * text end, so slash paths (`/nfs-hg/xxx`, `/plan.md`) and punctuation-glued
 * tokens (`/plan。`) stay plain even for a loaded name.
 */
import { Fragment, type ReactNode } from 'react'
import clsx from 'clsx'
import { ReferenceIconRegular } from './ReferenceIcon.tsx'
import css from './user-text.module.css'
import markdownCss from './markdown/MarkdownText.module.css'

/** One exact span a custom decorator claims in one sent text. */
export interface UserTextDecorationRange {
  readonly start: number
  readonly end: number
  /** Advisory hover title; the matched source text when absent. */
  readonly title?: string
}

/**
 * One registered decorator: an extra inline chip source for sent user text
 * (bubble and queue rows). Decorator spans claim first and shadow the
 * built-in shape scans on shared ranges; registration order resolves
 * overlaps between decorators.
 */
export interface UserTextDecorator {
  /** Unique registry id; duplicate registration throws. */
  readonly name: string
  /**
   * Find claimed spans in one text.
   * @param text - the logged model text of the message or queue row.
   * @returns exact, non-overlapping spans in source order.
   */
  find(text: string): readonly UserTextDecorationRange[]
  /**
   * Render the chip for one claimed span.
   * @param range - the claimed span.
   * @param matchedText - `text.slice(range.start, range.end)`.
   * @returns the inline chip node.
   */
  render(range: UserTextDecorationRange, matchedText: string): ReactNode
}

/** All registered decorators, in registration order. */
const decorators: UserTextDecorator[] = []

/**
 * Register one custom text decorator.
 * @param decorator - the decorator; `name` must be unique — duplicates throw.
 * @returns the disposer.
 */
export function registerUserTextDecorator(decorator: UserTextDecorator): () => void {
  if (decorators.some(existing => existing.name === decorator.name)) {
    throw new Error(`user-text decorator "${decorator.name}" is already registered`)
  }
  decorators.push(decorator)
  return () => {
    const at = decorators.indexOf(decorator)
    if (at >= 0) decorators.splice(at, 1)
  }
}

/** The wire form a session chip serializes to; label is the display text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/** Sentence punctuation a bare `@name` token may carry without being part of the reference. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u

interface DecorationRange {
  readonly start: number
  readonly end: number
  /** Matched source text (hover title). */
  readonly label: string
  readonly kind: 'session' | 'plain' | 'custom'
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string
  /** Owning decorator + its claim when kind is 'custom'. */
  readonly decorator?: UserTextDecorator
  readonly claim?: UserTextDecorationRange
}

/** Optional navigation supplied by consumers that can preview references. */
export interface UserTextReferences {
  /** Open a file path decoded from an `@` mention. */
  openFile: (path: string) => void
  /** Open the source of a skill loaded for this message. */
  openSkill: (name: string) => void
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as: the skills the
 * host loaded for this message, or the command a command bubble echoes
 * (unsent queue rows pass none).
 * @param slashKind - the chip kind those tokens render as.
 * @param references - optional file and skill preview actions; session and command tokens stay labels.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
  references?: UserTextReferences,
): ReactNode {
  const ranges: DecorationRange[] = []
  // Registered decorators claim first; the built-in shape scans below skip
  // any range overlapping a claim, so a claim shadows a shape match on the
  // same span and never loses to an earlier-starting shape token.
  const claims: { range: UserTextDecorationRange; decorator: UserTextDecorator }[] = []
  for (const decorator of decorators) {
    for (const claim of decorator.find(text)) claims.push({ range: claim, decorator })
  }
  const overlapsClaim = (start: number, end: number): boolean =>
    claims.some(claimed => start < claimed.range.end && claimed.range.start < end)
  for (const { range: claim, decorator } of claims) {
    ranges.push({
      start: claim.start,
      end: claim.end,
      label: text.slice(claim.start, claim.end),
      kind: 'custom',
      decorator,
      claim,
    })
  }
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    if (overlapsClaim(wire.index, wire.index + wire[0].length)) continue
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display: wire[1] as string, // non-optional capture in SESSION_WIRE_RE
    })
  }
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      if (!overlapsClaim(start, start + label.length)) {
        ranges.push({ start, end: start + label.length, label, kind: 'session' })
      }
      start = text.indexOf(label, start + label.length)
    }
  }
  // A `/` token ends at whitespace or the text end like the host skill
  // gesture; only `@` tokens shed sentence punctuation below.
  const re = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1] as string).length // (^|\s) captures '' at line start
    const rawLabel = m[2] as string // non-optional alternation capture
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length <= 1) continue
    if (label.startsWith('/') && !slashNames.includes(label.slice(1))) continue
    if (overlapsClaim(tokenStart, tokenStart + label.length)) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  const rankOf = (range: DecorationRange): number => range.kind === 'session' ? 0 : range.kind === 'custom' ? 1 : 2
  ranges.sort((a, b) => a.start - b.start || rankOf(a) - rankOf(b) || b.end - a.end)
  const parts: ReactNode[] = []
  let cursor = 0
  const pushPlain = (from: number, to: number): void => {
    parts.push(<span key={`t${from}`} className={css.plainRun}>{text.slice(from, to)}</span>)
  }
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) pushPlain(cursor, tokenStart)
    if (kind === 'custom' && range.decorator !== undefined && range.claim !== undefined) {
      parts.push(
        <Fragment key={`custom:${tokenStart}`}>
          {range.decorator.render(range.claim, label)}
        </Fragment>,
      )
      cursor = end
      continue
    }
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.replace(/^@"|"$/gu, '').endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = range.display
      ?? (referenceKind === undefined
        ? label
        : referenceKind === 'session'
          ? label.slice(1)
          : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1))
    const contents = <>
      {referenceKind !== undefined && (
        <ReferenceIconRegular kind={referenceKind} size={16} className={css.refIcon} />
      )}
      {displayLabel}
    </>
    const open = references === undefined ? undefined
      : referenceKind === 'file'
        ? () => { references.openFile(label.slice(1).replace(/^"|"$/gu, '')) }
        : referenceKind === undefined && slashKind === 'skill'
          ? () => { references.openSkill(label.slice(1)) }
          : undefined
    const className = clsx(css.refChip, referenceKind === undefined && css.slashChip)
    parts.push(open === undefined
      ? <span key={tokenStart} className={className} data-ref-chip={referenceKind ?? slashKind} title={label}>
        {contents}
      </span>
      : <button
        key={tokenStart}
        type="button"
        className={clsx(className, markdownCss.fileMention)}
        data-ref-chip={referenceKind ?? slashKind}
        title={label}
        onClick={(event) => {
          if (event.detail > 1 || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
          open()
        }}
      >
        {contents}
      </button>)
    cursor = end
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>
  if (cursor < text.length) pushPlain(cursor, text.length)
  return <>{parts}</>
}
