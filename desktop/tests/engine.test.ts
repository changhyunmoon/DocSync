import { describe, expect, it } from 'vitest'
import { applyItem, checkMapping, undoItem, editApplied, type FsLike, type ApplyRecord } from '../src/main/core/engine'
import type { Item, Mapping } from '@shared/types'

class MemFs implements FsLike {
  files = new Map<string, string>()
  failOn: string | null = null
  constructor(init: Record<string, string>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v)
  }
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null
  }
  async write(p: string, c: string) {
    if (this.failOn === p) throw new Error('disk full')
    this.files.set(p, c)
  }
  async remove(p: string) {
    this.files.delete(p)
  }
}

let n = 0
const map = (file: string, oldText: string, newText: string, extra: Partial<Mapping> = {}): Mapping => ({
  id: `m${++n}`, file, section: '', relation: '보완', reason: '', existing: '', oldText, newText, ...extra
})
const item = (id: string, mappings: Mapping[]): Item => ({
  id, no: 1, kind: 'content', title: id, detail: '', confirmed: true, status: 'approved', evidence: [], mappings
})

const L1 = '로그인 실패 시 메시지를 표시한다.'
const base = () => ({
  'docs/auth/login.md': `# 로그인\n\n## 실패 처리\n${L1}\n`,
  'docs/api/errors.md': '| 코드 | 의미 |\n| AUTH_001 | 불일치 |\n'
})

describe('applyItem', () => {
  it('여러 파일 변경을 한 단위로 반영한다', async () => {
    const fs = new MemFs(base())
    const it1 = item('i1', [
      map('docs/auth/login.md', L1, `${L1}\n5회 실패 시 15분 잠금.`),
      map('docs/api/errors.md', '| AUTH_001 | 불일치 |', '| AUTH_001 | 불일치 |\n| AUTH_LOCKED | 잠김 |', { relation: '신규' })
    ])
    const r = await applyItem(it1, fs, 1)
    expect(r.ok).toBe(true)
    expect(fs.files.get('docs/auth/login.md')).toContain('15분 잠금')
    expect(fs.files.get('docs/api/errors.md')).toContain('AUTH_LOCKED')
  })

  it('기준 내용이 없으면 아무 파일도 바꾸지 않는다', async () => {
    const fs = new MemFs(base())
    const before = new Map(fs.files)
    const r = await applyItem(item('i', [map('docs/auth/login.md', L1, 'x'), map('docs/api/errors.md', '없는 줄', 'y')]), fs, 1)
    expect(r.ok).toBe(false)
    expect(fs.files).toEqual(before)
  })

  it('쓰기 중간 실패 시 앞서 쓴 파일을 복구한다', async () => {
    const fs = new MemFs(base())
    const before = new Map(fs.files)
    fs.failOn = 'docs/api/errors.md'
    const r = await applyItem(item('i', [map('docs/auth/login.md', L1, 'A'), map('docs/api/errors.md', '| AUTH_001 | 불일치 |', 'B')]), fs, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('복구했습니다')
    expect(fs.files).toEqual(before)
  })

  it('oldText가 빈 문자열이면 새 파일을 만든다', async () => {
    const fs = new MemFs(base())
    const r = await applyItem(item('i', [map('docs/new.md', '', '# 새 문서\n', { relation: '신규' })]), fs, 1)
    expect(r.ok).toBe(true)
    expect(fs.files.get('docs/new.md')).toBe('# 새 문서\n')
  })

  it('기준 문구가 여러 번 나오면 모호하다고 판단한다', () => {
    expect(checkMapping(map('a', 'x', 'y'), 'x x')).toBe('ambiguous')
    expect(checkMapping(map('a', 'z', 'y'), 'x x')).toBe('missing')
  })
})

describe('undoItem', () => {
  it('같은 구간을 나중에 고친 항목이 있으면 먼저 되돌리도록 막는다', async () => {
    const fs = new MemFs(base())
    const a = item('a', [map('docs/auth/login.md', L1, `${L1}\nA줄`)])
    const ra = (await applyItem(a, fs, 1)) as { ok: true; value: ApplyRecord }
    const b = item('b', [map('docs/auth/login.md', `${L1}\nA줄`, `${L1}\nA줄\nB줄`)])
    const rb = (await applyItem(b, fs, 2)) as { ok: true; value: ApplyRecord }
    const u = await undoItem(ra.value, fs, [rb.value])
    expect(u.ok).toBe(false)
    if (!u.ok) expect(u.error).toBe('blocker:b')
    expect((await undoItem(rb.value, fs, [ra.value])).ok).toBe(true)
    expect((await undoItem(ra.value, fs, [])).ok).toBe(true)
    expect(fs.files).toEqual(new MemFs(base()).files)
  })

  it('다른 구간이 바뀌었으면 이 항목의 치환만 되돌린다', async () => {
    const fs = new MemFs(base())
    const a = item('a', [map('docs/auth/login.md', L1, `${L1}\nA줄`)])
    const ra = (await applyItem(a, fs, 1)) as { ok: true; value: ApplyRecord }
    fs.files.set('docs/auth/login.md', (fs.files.get('docs/auth/login.md') as string).replace('# 로그인', '# 로그인 정책'))
    expect((await undoItem(ra.value, fs, [])).ok).toBe(true)
    expect(fs.files.get('docs/auth/login.md')).toBe(`# 로그인 정책\n\n## 실패 처리\n${L1}\n`)
  })

  it('외부 수정으로 변경 위치를 찾을 수 없으면 중단한다', async () => {
    const fs = new MemFs(base())
    const ra = (await applyItem(item('a', [map('docs/auth/login.md', L1, `${L1}\nA줄`)]), fs, 1)) as { ok: true; value: ApplyRecord }
    fs.files.set('docs/auth/login.md', '전부 바뀜')
    const u = await undoItem(ra.value, fs, [])
    expect(u.ok).toBe(false)
    expect(fs.files.get('docs/auth/login.md')).toBe('전부 바뀜')
  })

  it('이동을 반영하고 되돌린다', async () => {
    const fs = new MemFs(base())
    const content = fs.files.get('docs/auth/login.md') as string
    const mv = item('mv', [map('docs/auth/login.md', content, content, { relation: '이동', moveTo: 'docs/security/login.md' })])
    const r = (await applyItem(mv, fs, 1)) as { ok: true; value: ApplyRecord }
    expect(r.ok).toBe(true)
    expect(fs.files.has('docs/auth/login.md')).toBe(false)
    expect(fs.files.get('docs/security/login.md')).toBe(content)
    expect((await undoItem(r.value, fs, [])).ok).toBe(true)
    expect(fs.files.get('docs/auth/login.md')).toBe(content)
    expect(fs.files.has('docs/security/login.md')).toBe(false)
  })
})

describe('같은 새 문서에 여러 항목 (순서 무관)', () => {
  const A = () => item('A', [map('docs/new.md', '', '# 계정 정책\n\n잠금 규칙', { relation: '신규' })])
  const B = () => item('B', [map('docs/new.md', '', '해제 절차', { relation: '신규' })])

  for (const [first, second] of [['A', 'B'], ['B', 'A']] as const) {
    it(`${first} → ${second} 순서로 반영해도 둘 다 들어가고, 어느 쪽이든 먼저 되돌릴 수 있다`, async () => {
      const fs = new MemFs(base())
      const items = { A: A(), B: B() }
      const created = new Set<string>()
      const r1 = (await applyItem(items[first], fs, 1)) as { ok: true; value: ApplyRecord }
      const r2 = (await applyItem(items[second], fs, 2)) as { ok: true; value: ApplyRecord }
      expect(r1.ok && r2.ok).toBe(true)
      r1.value.ops.forEach((o) => o.before === null && created.add(o.path))
      const f = fs.files.get('docs/new.md') as string
      expect(f).toContain('잠금 규칙')
      expect(f).toContain('해제 절차')
      // 먼저 반영한 쪽을 먼저 되돌린다 (예전에는 막혔음)
      const u1 = await undoItem(r1.value, fs, [r2.value], created)
      expect(u1.ok).toBe(true)
      const after1 = fs.files.get('docs/new.md') as string
      expect(after1.includes('잠금 규칙')).toBe(first === 'B')
      expect(after1.includes('해제 절차')).toBe(first === 'A')
      // 남은 쪽도 되돌리면 앱이 만든 파일은 사라진다
      const u2 = await undoItem(r2.value, fs, [], created)
      expect(u2.ok).toBe(true)
      expect(fs.files.has('docs/new.md')).toBe(false)
    })
  }

  it('기존 파일 끝에 덧붙인 두 항목도 순서 없이 되돌린다', async () => {
    const fs = new MemFs(base())
    const a = item('a', [map('docs/api/errors.md', '', '| E1 | 하나 |')])
    const b = item('b', [map('docs/api/errors.md', '', '| E2 | 둘 |')])
    const ra = (await applyItem(a, fs, 1)) as { ok: true; value: ApplyRecord }
    const rb = (await applyItem(b, fs, 2)) as { ok: true; value: ApplyRecord }
    expect((await undoItem(ra.value, fs, [rb.value])).ok).toBe(true)
    expect(fs.files.get('docs/api/errors.md')).toBe(base()['docs/api/errors.md'] + '| E2 | 둘 |\n')
    expect((await undoItem(rb.value, fs, [])).ok).toBe(true)
    expect(fs.files.get('docs/api/errors.md')).toBe(base()['docs/api/errors.md'])
  })
})

describe('반영된 항목 직접 수정', () => {
  it('반영 후 고친 내용도 되돌리기로 깨끗이 빠진다', async () => {
    const fs = new MemFs(base())
    const m = map('docs/auth/login.md', L1, `${L1}\nA줄`)
    const r = (await applyItem(item('a', [m]), fs, 1)) as { ok: true; value: ApplyRecord }
    const cur = fs.files.get('docs/auth/login.md') as string
    const e = editApplied(cur, m.newText, `${L1}\nA줄 수정됨`, r.value, 'docs/auth/login.md')
    expect(e.ok).toBe(true)
    if (e.ok) await fs.write('docs/auth/login.md', e.value)
    expect(fs.files.get('docs/auth/login.md')).toContain('A줄 수정됨')
    expect((await undoItem(r.value, fs, [])).ok).toBe(true)
    expect(fs.files).toEqual(new MemFs(base()).files)
  })

  it('덧붙인 내용을 고친 뒤 다른 항목과 섞여 있어도 되돌린다', async () => {
    const fs = new MemFs(base())
    const ma = map('docs/api/errors.md', '', '| E1 | 하나 |')
    const ra = (await applyItem(item('a', [ma]), fs, 1)) as { ok: true; value: ApplyRecord }
    const rb = (await applyItem(item('b', [map('docs/api/errors.md', '', '| E2 | 둘 |')]), fs, 2)) as { ok: true; value: ApplyRecord }
    const e = editApplied(fs.files.get('docs/api/errors.md') as string, ma.newText, '| E1 | 하나(수정) |', ra.value, 'docs/api/errors.md')
    if (e.ok) await fs.write('docs/api/errors.md', e.value)
    expect((await undoItem(ra.value, fs, [rb.value])).ok).toBe(true)
    expect(fs.files.get('docs/api/errors.md')).toBe(base()['docs/api/errors.md'] + '| E2 | 둘 |\n')
  })

  it('전부 지우거나 구간을 못 찾으면 거부한다', () => {
    expect(editApplied('abc', 'b', '  ').ok).toBe(false)
    expect(editApplied('abc', 'z', 'y').ok).toBe(false)
  })
})
