// 원문 근거 위치 찾기와 형광펜 구간 계산 (main·renderer 공용, 순수 함수)

/** quote를 text에서 찾아 [start, end)를 돌려준다. 공백 차이는 허용한다. */
export function locateQuote(text: string, quote: string): [number, number] | null {
  const q = quote.trim()
  if (!q) return null
  const i = text.indexOf(q)
  if (i >= 0) return [i, i + q.length]
  // 공백을 정규화한 문자열에서 찾은 뒤 원래 offset으로 되돌린다
  const map: number[] = []
  let norm = ''
  let prevSpace = false
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (/\s/.test(ch)) {
      if (prevSpace) continue
      prevSpace = true
      norm += ' '
    } else {
      prevSpace = false
      norm += ch
    }
    map.push(k)
  }
  const nq = q.replace(/\s+/g, ' ')
  const j = norm.indexOf(nq)
  if (j < 0) return null
  return [map[j], map[j + nq.length - 1] + 1]
}

export interface Segment {
  start: number
  end: number
  text: string
  itemIds: string[]
}

/** 여러 근거 구간을 겹치지 않는 조각으로 나눈다 */
export function buildSegments(text: string, ranges: { start: number; end: number; itemId: string }[]): Segment[] {
  const cuts = new Set<number>([0, text.length])
  for (const r of ranges) {
    cuts.add(Math.max(0, Math.min(text.length, r.start)))
    cuts.add(Math.max(0, Math.min(text.length, r.end)))
  }
  const pts = [...cuts].sort((a, b) => a - b)
  const segs: Segment[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i]
    const e = pts[i + 1]
    if (e <= s) continue
    const ids = [...new Set(ranges.filter((r) => r.start <= s && r.end >= e).map((r) => r.itemId))]
    const prev = segs[segs.length - 1]
    if (prev && prev.end === s && prev.itemIds.join() === ids.join()) {
      prev.end = e
      prev.text += text.slice(s, e)
    } else {
      segs.push({ start: s, end: e, text: text.slice(s, e), itemIds: ids })
    }
  }
  return segs
}

/** 항목의 모든 대상 문서에 같은 내용이 이미 있는가 (중복 매핑만 있음) */
export function existsAlready(it: { kind?: string; mappings: { relation: string; file: string | null }[] }): boolean {
  if (it.kind === 'move') return false
  // 대상 없는 "판단 필요"가 섞여 있으면 이미 존재로 보지 않는다
  return it.mappings.length > 0 && it.mappings.every((m) => m.relation === '중복' && !!m.file)
}
