// Markdown 상대 링크·이미지 경로 분석과 문서 이동 시 링크 수정안 계산
import { posix } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'

export interface LinkRef {
  start: number // raw URL의 시작 offset
  end: number
  raw: string
}

const parser = unified().use(remarkParse)

function walk(node: Root | RootContent, out: (RootContent & { url: string })[]): void {
  if ('url' in node && typeof (node as { url?: unknown }).url === 'string') out.push(node as RootContent & { url: string })
  if ('children' in node && Array.isArray(node.children)) for (const c of node.children) walk(c as RootContent, out)
}

/** 링크·이미지·참조 정의의 URL 위치를 원문 offset 기준으로 찾는다 */
export function extractLinks(md: string): LinkRef[] {
  const tree = parser.parse(md) as Root
  const nodes: (RootContent & { url: string })[] = []
  walk(tree, nodes)
  const refs: LinkRef[] = []
  for (const n of nodes) {
    const s = n.position?.start.offset
    const e = n.position?.end.offset
    if (s == null || e == null) continue
    const slice = md.slice(s, e)
    let i: number
    if (n.type === 'definition') {
      const k = slice.indexOf(']:')
      if (k < 0) continue
      i = k + 2
    } else {
      const k = slice.lastIndexOf('](')
      if (k < 0) continue // 참조형 링크 [a][b]는 정의 쪽에서 처리
      i = k + 2
    }
    while (i < slice.length && /[ \t]/.test(slice[i])) i++
    let j: number
    if (slice[i] === '<') {
      i++
      j = slice.indexOf('>', i)
      if (j < 0) continue
    } else {
      j = i
      let depth = 0
      while (j < slice.length) {
        const ch = slice[j]
        if (/\s/.test(ch)) break
        if (ch === '(') depth++
        if (ch === ')') {
          if (depth === 0) break
          depth--
        }
        j++
      }
    }
    const raw = slice.slice(i, j)
    if (raw) refs.push({ start: s + i, end: s + j, raw })
  }
  return refs
}

export function isRelativeUrl(raw: string): boolean {
  if (!raw) return false
  if (raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('//')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false
  return true
}

function splitUrl(raw: string): { path: string; suffix: string } {
  const m = raw.match(/^([^?#]*)(.*)$/) as RegExpMatchArray
  return { path: m[1], suffix: m[2] }
}

function decode(p: string): string {
  try {
    return decodeURI(p)
  } catch {
    return p
  }
}

export interface MoveEdit {
  path: string // 원래 경로
  newPath: string // 이동 후 경로 (이동하지 않으면 path와 같음)
  oldContent: string
  newContent: string
  changedLinks: number
}

export interface MovePlan {
  edits: MoveEdit[]
  notes: string[]
}

/**
 * pairs: [from, to] 파일 이동 목록 (프로젝트 루트 기준 posix 경로)
 * docs: 프로젝트 안 모든 Markdown 파일의 내용
 */
export function planMove(pairs: [string, string][], docs: Record<string, string>): MovePlan {
  const map = new Map(pairs)
  const mapPath = (p: string): string => map.get(p) ?? p
  const edits: MoveEdit[] = []
  const notes: string[] = []

  for (const [file, content] of Object.entries(docs)) {
    const newFile = mapPath(file)
    const refs = extractLinks(content)
    let next = content
    let changed = 0
    for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
      if (!isRelativeUrl(ref.raw)) continue
      const { path, suffix } = splitUrl(ref.raw)
      if (!path) continue
      const target = posix.normalize(posix.join(posix.dirname(file), decode(path)))
      const newTarget = mapPath(target)
      if (newFile === file && newTarget === target) continue
      let rel = posix.relative(posix.dirname(newFile), newTarget) || posix.basename(newTarget)
      if (path.startsWith('./') && !rel.startsWith('.')) rel = './' + rel
      if (ref.raw.includes('%')) rel = encodeURI(rel)
      if (rel + suffix === ref.raw) continue
      next = next.slice(0, ref.start) + rel + suffix + next.slice(ref.end)
      changed++
    }
    if (newFile !== file || next !== content) {
      edits.push({ path: file, newPath: newFile, oldContent: content, newContent: next, changedLinks: changed })
    }
    // 자동으로 고치지 않는 본문 경로 표현 안내
    for (const [from] of pairs) {
      if (file === from) continue
      const linked = new Set(refs.map((r) => r.raw))
      if (content.includes(from) && ![...linked].some((r) => r.includes(from))) {
        notes.push(`${file}: 본문에 '${from}' 경로 표현이 있습니다. 자동으로 수정하지 않으니 직접 확인하세요.`)
      }
    }
  }
  return { edits, notes }
}
