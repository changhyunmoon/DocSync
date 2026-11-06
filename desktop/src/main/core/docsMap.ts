// 문서 지도(docs_map.md): 반영 범위 문서마다 성격·내용 요약을 담아 두고,
// AI에는 전체 문서 대신 지도를 먼저 보내 관련 문서만 고르게 한다.
// 사람이 읽고 고칠 수 있는 Markdown이며, 파일이 바뀐 문서의 설명만 다시 만든다.
import { createHash } from 'node:crypto'
import * as path from 'node:path'

export const MAP_NAME = 'docs_map.md'

export interface MapEntry {
  /** 프로젝트 기준 경로 */
  path: string
  /** 문서 성격 (정책, 가이드, 명세, 절차, 목차 …) */
  kind: string
  /** 담고 있는 내용 한두 줄 */
  summary: string
  /** 섹션 제목 */
  sections: string[]
  /** 설명을 만든 시점의 파일 내용 해시 (다르면 설명을 다시 만든다) */
  hash: string
  /** AI 설명 작성에 실패한 횟수 (제목 기준 임시 설명). 한도에 닿으면 더 시도하지 않는다 */
  fails?: number
}

/** AI 설명을 다시 시도하는 최대 횟수 (넘으면 파일이 바뀔 때까지 임시 설명을 유지) */
export const MAX_SUMMARY_FAILS = 2

const posix = path.posix

/** 지도 파일 위치: 반영 범위의 첫 폴더 바로 아래 (범위가 없으면 프로젝트 최상위) */
export function mapPathOf(scope: string[]): string {
  return scope.length ? posix.join(scope[0], MAP_NAME) : MAP_NAME
}

export function isMapFile(p: string | null | undefined): boolean {
  return !!p && posix.basename(p) === MAP_NAME
}

export function hashOf(content: string): string {
  return createHash('sha1').update(content.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}

/** 섹션 제목(## ~ ###) 추출 */
export function headingsOf(content: string, max = 10): string[] {
  const out: string[] = []
  let fence = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/)
    if (m) out.push(m[1].replace(/\s+/g, ' ').slice(0, 40))
    if (out.length >= max) break
  }
  return out
}

/** AI 없이 만드는 기본 설명 (제목과 첫 문단) */
export function localSummary(content: string): { kind: string; summary: string } {
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '') ?? ''
  const first = lines.find((l) => l && !/^(#|>|\||```|---|<!--|!\[)/.test(l)) ?? ''
  const text = [title, first.replace(/^[-*]\s+/, '')].filter(Boolean).join(' — ')
  return { kind: '', summary: text.slice(0, 120) || '(내용 없음)' }
}

const esc = (s: string): string => s.replace(/\r?\n/g, ' ').trim()

export function renderMap(entries: MapEntry[], mapPath: string): string {
  const dir = posix.dirname(mapPath)
  const rel = (p: string): string => (dir === '.' ? p : posix.relative(dir, p))
  const lines = [
    '# docs_map',
    '',
    '> DocSync가 회의록·기획안의 항목과 관련된 문서만 골라 AI에 보낼 때 쓰는 문서 지도입니다.',
    '> 성격·내용 설명은 직접 고쳐도 됩니다. 문서 내용이 바뀌면 그 문서의 설명만 다시 만들어집니다.',
    ''
  ]
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const r = rel(e.path)
    lines.push(`## [${r}](${encodeURI(r)})`)
    if (e.kind) lines.push(`- 성격: ${esc(e.kind)}`)
    lines.push(`- 내용: ${esc(e.summary)}`)
    if (e.sections.length) lines.push(`- 섹션: ${e.sections.map(esc).join(' · ')}`)
    lines.push(`<!-- docsync:hash=${e.hash}${e.fails ? `;fails=${e.fails}` : ''} -->`)
    lines.push('')
  }
  return lines.join('\n')
}

export function parseMap(text: string, mapPath: string): MapEntry[] {
  const dir = posix.dirname(mapPath)
  const abs = (r: string): string => posix.normalize(dir === '.' ? r : posix.join(dir, r))
  const out: MapEntry[] = []
  let cur: MapEntry | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const h = line.match(/^##\s+(?:\[([^\]]+)\]\(([^)]+)\)|(.+))$/)
    if (h) {
      let target = h[2] ?? h[3] ?? ''
      try {
        target = decodeURI(target)
      } catch {
        /* 그대로 사용 */
      }
      cur = { path: abs(target.trim()), kind: '', summary: '', sections: [], hash: '' }
      out.push(cur)
      continue
    }
    if (!cur) continue
    let m: RegExpMatchArray | null
    if ((m = line.match(/^[-*]\s*성격\s*[:：]\s*(.*)$/))) cur.kind = m[1].trim()
    else if ((m = line.match(/^[-*]\s*내용\s*[:：]\s*(.*)$/))) cur.summary = m[1].trim()
    else if ((m = line.match(/^[-*]\s*섹션\s*[:：]\s*(.*)$/))) cur.sections = m[1].split('·').map((s) => s.trim()).filter(Boolean)
    else if ((m = line.match(/<!--\s*docsync:hash=([0-9a-f]*)(?:;fails=(\d+))?\s*-->/))) {
      cur.hash = m[1]
      if (m[2]) cur.fails = Number(m[2])
    }
  }
  return out
}

/** AI에 보낼 압축 형태 */
export function mapForPrompt(entries: MapEntry[]): string {
  return entries
    .map((e) => `- ${e.path}${e.kind ? ` [${e.kind}]` : ''}: ${e.summary}${e.sections.length ? ` (섹션: ${e.sections.join(', ')})` : ''}`)
    .join('\n')
}

/**
 * 현재 문서 목록과 기존 지도를 비교해 다시 설명을 만들 문서를 고른다.
 * 해시가 같은 항목은 사람이 고친 설명까지 그대로 유지한다.
 */
export function diffMap(
  existing: MapEntry[],
  docs: { path: string; content: string }[]
): { keep: MapEntry[]; stale: { path: string; content: string; hash: string; fails: number }[]; removed: number } {
  const byPath = new Map(existing.map((e) => [e.path, e]))
  const keep: MapEntry[] = []
  const stale: { path: string; content: string; hash: string; fails: number }[] = []
  for (const d of docs) {
    const h = hashOf(d.content)
    const e = byPath.get(d.path)
    const same = !!e && e.hash === h && !!e.summary
    // 내용이 그대로면 유지. 단, AI 설명에 실패했던 문서는 한도까지만 다시 시도한다
    if (same && (!e.fails || e.fails >= MAX_SUMMARY_FAILS)) keep.push(e)
    else stale.push({ path: d.path, content: d.content, hash: h, fails: same ? (e.fails ?? 0) : 0 })
  }
  const live = new Set(docs.map((d) => d.path))
  const removed = existing.filter((e) => !live.has(e.path)).length
  return { keep, stale, removed }
}
