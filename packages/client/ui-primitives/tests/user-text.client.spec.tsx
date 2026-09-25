// @vitest-environment jsdom
/**
 * Inline projection of sent user text: decoration adds no block containers,
 * preserves whitespace, and folds wire session forms to their label.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import {
  projectUserText, registerUserTextDecorator,
  type UserTextDecorationRange, type UserTextDecorator,
} from '../src/user-text.tsx'

const project = (
  text: string,
  labels: readonly string[] = [],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
) =>
  render(<div data-host>{projectUserText(text, labels, slashNames, slashKind)}</div>).container.querySelector('[data-host]')!

describe('projectUserText', () => {
  it('keeps decorated text inline and preserves whitespace between references', () => {
    const host = project('反反复复 /dsh-acp-test @执行几个命令测试', ['执行几个命令测试'], ['dsh-acp-test'])
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.textContent).toBe('反反复复 /dsh-acp-test 执行几个命令测试')
    const chips = host.querySelectorAll('[data-ref-chip]')
    expect([...chips].map(c => c.getAttribute('data-ref-chip'))).toEqual(['skill', 'session'])
    // The whitespace between tokens survives as its own inline run.
    const runs = [...host.querySelectorAll('span')].filter(s => !s.hasAttribute('data-ref-chip') && s.closest('[data-ref-chip]') === null)
    expect(runs.map(r => r.textContent)).toEqual(['反反复复 ', ' '])
  })

  it('folds the wire session form to its label with the session glyph', () => {
    const host = project('看看 @[查看并分析图片](dsh-session:InNlc3Npb24tNDM0) 的结论')
    const chip = host.querySelector('[data-ref-chip="session"]')!
    expect(chip.textContent).toBe('查看并分析图片')
    expect(chip.getAttribute('title')).toBe('@[查看并分析图片](dsh-session:InNlc3Npb24tNDM0)')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(host.textContent).toBe('看看 查看并分析图片 的结论')
  })

  it('prefers the wire fold over the bare-token scan on the same range', () => {
    const host = project('@[a](dsh-session:x)', [])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(1)
    expect(host.querySelector('[data-ref-chip="session"]')!.textContent).toBe('a')
  })

  it('decorates recall-associated labels, files, folders, and quoted paths', () => {
    const host = project('@会话一 说 @src/deep/file.txt 与 @dir/ 与 @"a b.md"', ['会话一'])
    const kinds = [...host.querySelectorAll('[data-ref-chip]')].map(c =>
      [c.getAttribute('data-ref-chip'), c.textContent])
    expect(kinds).toEqual([
      ['session', '会话一'],
      ['file', 'file.txt'],
      ['folder', 'dir'],
      ['file', 'a b.md'],
    ])
  })

  it('repeated recall labels decorate every occurrence once', () => {
    const host = project('@再看 前情 @再看', ['再看', '再看'])
    expect(host.querySelectorAll('[data-ref-chip="session"]').length).toBe(2)
  })

  it('keeps a punctuation-glued slash token plain and skips degenerate tokens', () => {
    // The host skill gesture ends at whitespace or the text end, so `/plan。`
    // never loads a skill; the bubble must not suggest otherwise.
    const host = project('用 /plan。 试试 @。', [], ['plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('用 /plan。 试试 @。')
  })

  it('decorates a slash token only when the host resolved it as a skill in that step', () => {
    const bare = project('/123')
    expect(bare.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(bare.textContent).toBe('/123')
    const unresolved = project('用 /plan 看看')
    expect(unresolved.querySelectorAll('[data-ref-chip]').length).toBe(0)
    const resolved = project('用 /plan 看看', [], ['plan'])
    expect([...resolved.querySelectorAll('[data-ref-chip]')].map(c => [c.getAttribute('data-ref-chip'), c.textContent]))
      .toEqual([['skill', '/plan']])
  })

  it('marks a resolved slash token as a command chip when the caller says so', () => {
    const host = project('/goal ship it\nsecond line', [], ['goal'], 'command')
    const chips = [...host.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(c => [c.getAttribute('data-ref-chip'), c.textContent])).toEqual([['command', '/goal']])
    expect(host.textContent).toBe('/goal ship it\nsecond line')
  })

  it('leaves slash paths undecorated even for a resolved name: a /name token ends at whitespace', () => {
    const text = '测试一下ui，不用管我：\n/nfs-hg/xxx/yyy 与 /root-dir/ 和 /plan.md'
    const host = project(text, [], ['nfs-hg', 'root-dir', 'plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe(text)
  })

  it('prefers the longer recall label when one nests inside another', () => {
    const host = project('@会话一 收尾', ['会话', '会话一'])
    const chips = [...host.querySelectorAll('[data-ref-chip="session"]')]
    expect(chips.map(c => c.textContent)).toEqual(['会话一'])
    expect(host.textContent).toBe('会话一 收尾')
  })

  it('falls back to the raw quoted label when the path has no basename', () => {
    const host = project('看 @"/" 下面')
    const chip = host.querySelector('[data-ref-chip="folder"]')!
    expect(chip.textContent).toBe('"/"')
  })

  it('opens decoded files and loaded skills without activating session, folder, or command references', () => {
    const openFile = vi.fn()
    const openSkill = vi.fn()
    const view = render(<div>{projectUserText(
      '@src/a.ts @"notes a.md" /review @history @dir/ @"dir a/"', ['history'], ['review'], 'skill',
      { openFile, openSkill },
    )}</div>)
    fireEvent.click(view.getByRole('button', { name: 'a.ts' }))
    fireEvent.click(view.getByRole('button', { name: 'notes a.md' }))
    fireEvent.click(view.getByRole('button', { name: '/review' }))
    expect(openFile.mock.calls).toEqual([['src/a.ts'], ['notes a.md']])
    expect(openSkill).toHaveBeenCalledWith('review')
    expect(view.container.querySelectorAll('button')).toHaveLength(3)
    const command = render(<div>{projectUserText('/help', [], ['help'], 'command', { openFile, openSkill })}</div>)
    expect(command.container.querySelector('button')).toBeNull()
  })

  it('preserves text-selection gestures and keyboard activation', () => {
    const openFile = vi.fn()
    const view = render(<div>{projectUserText('@notes.md', [], [], 'skill', { openFile, openSkill: vi.fn() })}</div>)
    const button = view.getByRole('button', { name: 'notes.md' })
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(button)
    selection.addRange(range)
    fireEvent.click(button, { detail: 1 })
    expect(openFile).not.toHaveBeenCalled()
    fireEvent.click(button, { detail: 0 })
    expect(openFile).toHaveBeenCalledWith('notes.md')
    selection.removeAllRanges()
    openFile.mockClear()
    fireEvent.click(button, { detail: 2 })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('renders undecorated text as one inline run', () => {
    const host = project('纯文本，无引用')
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('纯文本，无引用')
  })
})

describe('registerUserTextDecorator', () => {
  const kbDoc = (tag: string): UserTextDecorator => ({
    name: `kb-doc-${tag}`,
    find: (text: string) => {
      const re = /知识库文档 docid: [\w-]+/gu
      const ranges: UserTextDecorationRange[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, title: m[0] })
      }
      return ranges
    },
    render: (range, matchedText) => <em data-kb-doc={tag}>{`${matchedText}#${range.start}`}</em>,
  })

  it('claims its span first: a shape token overlapping the claim stays plain', () => {
    const dispose = registerUserTextDecorator(kbDoc('a'))
    try {
      // The bare-token scan would decorate `@知识库文档`; the claim shadows it.
      const host = project('@知识库文档 docid: abc-12 参考 @notes.md')
      expect(host.querySelectorAll('[data-kb-doc="a"]').length).toBe(1)
      expect(host.textContent).toBe('@知识库文档 docid: abc-12#1 参考 notes.md')
      expect(host.querySelectorAll('[data-ref-chip="file"]').length).toBe(1)
    } finally {
      dispose()
    }
  })

  it('coexists with the built-in wire fold and session chips', () => {
    const dispose = registerUserTextDecorator(kbDoc('b'))
    try {
      const host = project('看 @[会话甲](dsh-session:x) 与 知识库文档 docid: id-1', [])
      const kinds = [...host.querySelectorAll('[data-ref-chip], [data-kb-doc="b"]')]
        .map(c => c.getAttribute('data-ref-chip') ?? c.getAttribute('data-kb-doc'))
      expect(kinds).toEqual(['session', 'b'])
    } finally {
      dispose()
    }
  })

  it('first registration wins an overlap between decorators', () => {
    const disposeFirst = registerUserTextDecorator(kbDoc('one'))
    const disposeSecond = registerUserTextDecorator(kbDoc('two'))
    try {
      const host = project('知识库文档 docid: xyz')
      expect(host.querySelectorAll('[data-kb-doc="one"]').length).toBe(1)
      expect(host.querySelectorAll('[data-kb-doc="two"]').length).toBe(0)
    } finally {
      disposeFirst()
      disposeSecond()
    }
  })

  it('rejects duplicate names and the disposer unregisters', () => {
    const dispose = registerUserTextDecorator(kbDoc('dup'))
    expect(() => registerUserTextDecorator({ ...kbDoc('dup') })).toThrow('already registered')
    dispose()
    const host = project('知识库文档 docid: abc-1')
    expect(host.querySelectorAll('[data-kb-doc]').length).toBe(0)
    expect(host.textContent).toBe('知识库文档 docid: abc-1')
  })
})
