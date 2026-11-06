import { describe, expect, it } from 'vitest'
import { applyItem, undoItem, type FsLike } from '../src/main/core/engine'
import { fileReview, mappingSig, reviewCounts, syncItemStatus } from '@shared/review'
import type { Item, Mapping } from '@shared/types'

class MemFs implements FsLike {
  files = new Map<string, string>()
  constructor(init: Record<string, string>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v)
  }
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null
  }
  async write(p: string, c: string) {
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
const item = (mappings: Mapping[], status: Item['status'] = 'pending'): Item => ({
  id: `i${++n}`, no: 1, kind: 'content', title: 't', detail: '', confirmed: true, status, evidence: [], mappings
})
const approve = (m: Mapping) => {
  m.approvedSig = mappingSig(m)
}

describe('파일별 결정 (기존 유지 · 제안 채택 · 보류)', () => {
  it('채택 후 내용이 바뀌면(직접 수정) 그 파일의 채택이 풀린다', () => {
    const m = map('a.md', 'x', 'y')
    approve(m)
    expect(fileReview(m)).toBe('adopted')
    m.newText = 'z'
    expect(fileReview(m)).toBe('pending')
  })

  it('남은 파일을 모두 결정하면 항목 상태가 정해진다', () => {
    const a = map('a.md', 'x', 'y')
    const b = map('b.md', 'x', 'y')
    const it1 = item([a, b])
    approve(a)
    syncItemStatus(it1)
    expect(it1.status).toBe('pending')
    b.rejected = true
    syncItemStatus(it1)
    expect(it1.status).toBe('approved')
    expect(reviewCounts(it1)).toEqual({ total: 2, adopted: 1, kept: 1, held: 0, pending: 0 })
  })

  it('모든 파일을 기존 유지하면 항목은 기존 유지(rejected)가 된다', () => {
    const a = map('a.md', 'x', 'y', { rejected: true })
    const b = map('b.md', 'x', 'y', { rejected: true })
    const it1 = item([a, b])
    syncItemStatus(it1)
    expect(it1.status).toBe('rejected')
  })

  it('반영 대기 항목에서 파일 채택을 풀면 검토 대기로 돌아간다', () => {
    const a = map('a.md', 'x', 'y')
    const it1 = item([a], 'approved')
    syncItemStatus(it1)
    expect(it1.status).toBe('pending')
  })

  it('반영할 때 기존 유지한 파일은 쓰지 않고, 되돌리기도 채택한 파일만 되돌린다', async () => {
    const fs = new MemFs({ 'a.md': 'A old\n', 'b.md': 'B old\n' })
    const a = map('a.md', 'A old', 'A new')
    const b = map('b.md', 'B old', 'B new', { rejected: true })
    const it1 = item([a, b], 'approved')
    const r = await applyItem(it1, fs, 1)
    expect(r.ok).toBe(true)
    expect(fs.files.get('a.md')).toBe('A new\n')
    expect(fs.files.get('b.md')).toBe('B old\n')
    if (!r.ok) return
    expect(r.value.ops.map((o) => o.path)).toEqual(['a.md'])
    const u = await undoItem(r.value, fs, [])
    expect(u.ok).toBe(true)
    expect(fs.files.get('a.md')).toBe('A old\n')
  })

  it('기존 유지한 파일의 기준 문구가 없어져도 반영을 막지 않는다', async () => {
    const fs = new MemFs({ 'a.md': 'A old\n', 'b.md': 'changed\n' })
    const it1 = item([map('a.md', 'A old', 'A new'), map('b.md', 'B old', 'B new', { rejected: true })], 'approved')
    const r = await applyItem(it1, fs, 1)
    expect(r.ok).toBe(true)
  })

  it('채택 없이 보류가 있으면 항목은 보류, 보류 파일은 반영하지 않는다', async () => {
    const a = map('a.md', 'A old', 'A new', { held: true })
    const b = map('b.md', 'B old', 'B new', { rejected: true })
    const it1 = item([a, b])
    syncItemStatus(it1)
    expect(it1.status).toBe('held')
    expect(fileReview(a)).toBe('held')
    const fs = new MemFs({ 'a.md': 'A old\n', 'b.md': 'B old\n', 'c.md': 'C old\n' })
    const c = map('c.md', 'C old', 'C new')
    const it2 = item([a, b, c], 'approved')
    const r = await applyItem(it2, fs, 1)
    expect(r.ok).toBe(true)
    expect(fs.files.get('a.md')).toBe('A old\n')
    expect(fs.files.get('c.md')).toBe('C new\n')
  })
})
