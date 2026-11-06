// 반영·되돌리기 엔진. 파일 시스템은 FsLike로 추상화되어 있어 테스트에서 메모리 FS를 쓸 수 있다.
import type { Item, Mapping } from '@shared/types'
import { isActiveChange, isChange } from '@shared/review'

export { isChange }

export interface FsLike {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

/** 파일 단위 변경 기록. before/after가 null이면 "파일 없음" */
export interface FileOp {
  path: string
  before: string | null
  after: string | null
  /** 문서 이동으로 생긴 op (경로 단위로 엄격하게 되돌린다) */
  moved?: boolean
}

/** 항목 안에서 일어난 텍스트 치환 (부분 되돌리기와 충돌 판단에 사용) */
export interface TextChange {
  path: string
  oldText: string
  newText: string
}

export interface ApplyRecord {
  itemId: string
  order: number
  ops: FileOp[]
  texts: TextChange[]
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let i = hay.indexOf(needle)
  while (i >= 0) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

/** 현재 파일 내용 기준으로 매핑을 적용할 수 있는지 */
export function checkMapping(m: Mapping, content: string | null, targetExists = false): 'missing' | 'ambiguous' | null {
  if (!isChange(m)) return null
  if (m.moveTo) {
    if (content === null || content !== m.oldText || targetExists) return 'missing'
    return null
  }
  if (m.oldText === '') return null // 새 파일 생성 또는 끝에 추가
  if (content === null) return 'missing'
  const n = countOccurrences(content, m.oldText)
  if (n === 0) return 'missing'
  if (n > 1) return 'ambiguous'
  return null
}

export function describeProblem(p: 'missing' | 'ambiguous', file: string): string {
  return p === 'missing'
    ? `${file}: 변경 기준 내용을 현재 파일에서 찾을 수 없습니다.`
    : `${file}: 변경 기준 문구가 파일에 여러 번 나와 위치를 정할 수 없습니다.`
}

/** 한 매핑을 텍스트에 적용 */
export function applyText(content: string | null, m: Mapping): Result<string> {
  if (m.oldText === '') {
    if (content === null) return { ok: true, value: m.newText }
    // 문서 제목(# …)으로 시작하는 내용을 제목 없는 문서에 넣으면 맨 앞에 둔다 (다른 항목이 먼저 덧붙인 경우)
    if (/^# /.test(m.newText) && !/^# /m.test(content)) {
      return { ok: true, value: m.newText.replace(/\n*$/, '\n\n') + content.replace(/^\n+/, '') }
    }
    const sep = content.endsWith('\n') || content === '' ? '' : '\n'
    const tail = m.newText.endsWith('\n') ? '' : '\n'
    return { ok: true, value: content + sep + m.newText + tail }
  }
  const p = checkMapping(m, content)
  if (p) return { ok: false, error: describeProblem(p, m.file ?? '') }
  return { ok: true, value: (content as string).replace(m.oldText, () => m.newText) }
}

/** 항목 전체를 메모리에서 계산 → 파일 단위 op 목록 */
export async function planItem(item: Item, fs: FsLike): Promise<Result<{ ops: FileOp[]; texts: TextChange[] }>> {
  const before = new Map<string, string | null>()
  const after = new Map<string, string | null>()
  const order: string[] = []
  const movedPaths = new Set<string>()
  const texts: TextChange[] = []

  const load = async (p: string): Promise<string | null> => {
    if (after.has(p)) return after.get(p) as string | null
    const c = await fs.read(p)
    before.set(p, c)
    after.set(p, c)
    order.push(p)
    return c
  }

  for (const m of item.mappings) {
    // 파일별로 거절한 변경은 반영하지 않는다
    if (!isActiveChange(m)) continue
    const file = m.file as string
    if (m.moveTo) {
      const cur = await load(file)
      if (cur === null || cur !== m.oldText) return { ok: false, error: describeProblem('missing', file) }
      const dest = await load(m.moveTo)
      if (dest !== null) return { ok: false, error: `${m.moveTo}: 이동할 위치에 이미 파일이 있습니다.` }
      after.set(file, null)
      after.set(m.moveTo, m.newText)
      movedPaths.add(file)
      movedPaths.add(m.moveTo)
      texts.push({ path: m.moveTo, oldText: m.oldText, newText: m.newText })
      continue
    }
    const cur = await load(file)
    const r = applyText(cur, m)
    if (!r.ok) return r
    after.set(file, r.value)
    texts.push({ path: file, oldText: m.oldText, newText: m.newText })
  }

  const ops: FileOp[] = []
  for (const p of order) {
    const b = before.get(p) ?? null
    const a = after.get(p) ?? null
    if (b !== a) ops.push({ path: p, before: b, after: a, ...(movedPaths.has(p) ? { moved: true } : {}) })
  }
  if (!ops.length) return { ok: false, error: '적용할 변경이 없습니다.' }
  return { ok: true, value: { ops, texts } }
}

async function writeOps(ops: FileOp[], fs: FsLike, dir: 'forward' | 'backward'): Promise<Result<true>> {
  const done: FileOp[] = []
  try {
    for (const op of ops) {
      const target = dir === 'forward' ? op.after : op.before
      if (target === null) await fs.remove(op.path)
      else await fs.write(op.path, target)
      done.push(op)
    }
    return { ok: true, value: true }
  } catch (e) {
    // 이미 쓴 파일을 원래대로 복구 시도
    const failed: string[] = []
    for (const op of done.reverse()) {
      const restore = dir === 'forward' ? op.before : op.after
      try {
        if (restore === null) await fs.remove(op.path)
        else await fs.write(op.path, restore)
      } catch {
        failed.push(op.path)
      }
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (failed.length) {
      return { ok: false, error: `파일 쓰기 실패(${msg}). 복구에도 실패한 파일이 있습니다: ${failed.join(', ')} — 해당 파일을 직접 확인하세요.` }
    }
    return { ok: false, error: `파일 쓰기 실패(${msg}). 이 항목의 적용 전 상태로 복구했습니다.` }
  }
}

/** 항목 반영: 계산 → 쓰기 (실패 시 복구 시도) */
export async function applyItem(item: Item, fs: FsLike, order: number): Promise<Result<ApplyRecord>> {
  const plan = await planItem(item, fs)
  if (!plan.ok) return plan
  const w = await writeOps(plan.value.ops, fs, 'forward')
  if (!w.ok) return w
  return { ok: true, value: { itemId: item.id, order, ops: plan.value.ops, texts: plan.value.texts } }
}

function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

/**
 * 이 기록보다 나중에 반영된 것 중, 이 항목을 되돌리면 깨지는 기록.
 * - 나중 항목이 이 항목이 쓴 문구를 기준(oldText)으로 삼은 경우 (같은 구간 수정)
 * - 문서 이동으로 경로가 얽힌 경우
 * 같은 파일 끝에 덧붙이기만 한 경우는 서로 독립이므로 막지 않는다.
 */
export function findBlocker(rec: ApplyRecord, later: ApplyRecord[]): ApplyRecord | null {
  const myPaths = new Set(rec.ops.map((o) => o.path))
  const myMoved = new Set(rec.ops.filter((o) => o.moved).map((o) => o.path))
  for (const r of later) {
    if (r.order <= rec.order) continue
    for (const t of r.texts) {
      if (myPaths.has(t.path) && rec.texts.some((mine) => mine.path === t.path && overlaps(mine.newText, t.oldText))) return r
    }
    for (const op of r.ops) {
      if (op.moved && myPaths.has(op.path)) return r
      if (myMoved.has(op.path)) return r
    }
  }
  return null
}

/** 덧붙였던(또는 새로 만든) 내용을 빼낸다. 앞뒤 줄바꿈 하나도 함께 정리 */
export function removeAppended(content: string, text: string): string | null {
  if (!text) return content
  if (countOccurrences(content, text) !== 1) return null
  if (content === text) return ''
  if (content.includes('\n' + text + '\n')) return content.replace('\n' + text + '\n', () => '\n')
  if (content.startsWith(text + '\n')) return content.slice(text.length + 1).replace(/^\n+/, '')
  if (content.endsWith('\n' + text)) return content.slice(0, content.length - text.length - 1)
  return content.replace(text, () => '')
}

/**
 * 반영 되돌리기. 다른 항목이 같은 파일에 덧붙인 내용은 그대로 두고 이 항목의 변경만 걷어낸다.
 * createdPaths: 이번 실행에서 앱이 새로 만든 파일 (내용이 비면 파일도 지운다)
 */
export async function undoItem(rec: ApplyRecord, fs: FsLike, others: ApplyRecord[], createdPaths: Set<string> = new Set()): Promise<Result<true>> {
  const blocker = findBlocker(rec, others)
  if (blocker) return { ok: false, error: `blocker:${blocker.itemId}` }
  const touchedByOthers = (p: string) => others.some((r) => r !== rec && (r.ops.some((o) => o.path === p) || r.texts.some((t) => t.path === p)))

  const reverse: FileOp[] = []
  for (const op of rec.ops) {
    const cur = await fs.read(op.path)
    // 이동은 경로 단위로 엄격하게
    if (op.moved || op.after === null) {
      if (cur !== op.after) return { ok: false, error: `${op.path}: 반영 이후 파일이 바뀌어 안전하게 되돌릴 수 없습니다.` }
      reverse.push({ path: op.path, before: cur, after: op.before })
      continue
    }
    if (cur === op.after) {
      reverse.push({ path: op.path, before: cur, after: op.before })
      continue
    }
    if (cur === null) return { ok: false, error: `${op.path}: 파일이 삭제되어 되돌릴 수 없습니다.` }
    // 다른 변경이 섞였다면 이 항목의 치환만 거꾸로 적용
    let next: string | null = cur
    for (const t of rec.texts.filter((x) => x.path === op.path).reverse()) {
      if (next === null) break
      if (t.oldText === '') next = removeAppended(next, t.newText)
      else if (t.newText && countOccurrences(next, t.newText) === 1) next = next.replace(t.newText, () => t.oldText)
      else next = null
    }
    if (next === null) {
      return { ok: false, error: `${op.path}: 외부 수정이나 다른 편집으로 이 항목의 변경 위치를 특정할 수 없어 자동 되돌리기를 중단했습니다.` }
    }
    const createdHere = op.before === null || createdPaths.has(op.path)
    const empty = next.trim() === ''
    reverse.push({ path: op.path, before: cur, after: empty && createdHere && !touchedByOthers(op.path) ? null : next })
  }
  // reverse의 before=현재, after=복구 내용 → forward로 쓰기
  const w = await writeOps(reverse.reverse(), fs, 'forward')
  if (!w.ok) return w
  return { ok: true, value: true }
}

/**
 * 이미 반영된 항목의 내용을 고친다: 현재 파일에서 이 항목이 쓴 문구(prev)를 찾아 next로 바꾼다.
 * 반영 기록이 있으면 되돌리기가 계속 동작하도록 기록도 함께 고친다.
 */
export function editApplied(content: string, prev: string, next: string, rec?: ApplyRecord, path?: string): Result<string> {
  if (!next.trim()) return { ok: false, error: '내용을 모두 지울 수는 없습니다. 이 항목을 빼려면 "반영 되돌리기"를 사용하세요.' }
  if (!prev || countOccurrences(content, prev) !== 1) {
    return { ok: false, error: '현재 파일에서 이 항목이 반영한 내용을 찾을 수 없어(외부에서 바뀜) 여기서 고칠 수 없습니다. 파일 보기에서 직접 수정하세요.' }
  }
  const out = content.replace(prev, () => next)
  if (rec && path) {
    for (const t of rec.texts) if (t.path === path && t.newText === prev) t.newText = next
    for (const op of rec.ops) if (op.path === path && op.after === content) op.after = out
  }
  return { ok: true, value: out }
}
