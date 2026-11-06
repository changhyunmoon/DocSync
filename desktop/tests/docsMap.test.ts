import { describe, expect, it } from 'vitest'
import { diffMap, hashOf, mapPathOf, parseMap, renderMap, headingsOf, type MapEntry } from '../src/main/core/docsMap'

const e = (path: string, content: string, summary = '요약'): MapEntry => ({ path, kind: '정책', summary, sections: headingsOf(content), hash: hashOf(content) })

describe('docs_map', () => {
  it('반영 범위 폴더 아래에 둔다', () => {
    expect(mapPathOf(['docs'])).toBe('docs/docs_map.md')
    expect(mapPathOf([])).toBe('docs_map.md')
  })

  it('렌더링한 지도를 다시 읽으면 같은 내용이다 (상대 링크 ↔ 프로젝트 경로)', () => {
    const entries = [e('docs/auth/login.md', '# 로그인\n## 실패 처리\n## 잠금'), e('docs/한글 문서.md', '# 가')]
    const md = renderMap(entries, 'docs/docs_map.md')
    expect(md).toContain('## [auth/login.md](auth/login.md)')
    expect(md).toContain('- 섹션: 실패 처리 · 잠금')
    expect(parseMap(md, 'docs/docs_map.md')).toEqual([...entries].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('사람이 고친 설명은 파일이 그대로면 유지하고, 바뀐 문서만 다시 만든다', () => {
    const a = '# A\n본문', b = '# B\n본문'
    const md = renderMap([e('docs/a.md', a), e('docs/b.md', b)], 'docs/docs_map.md').replace('- 내용: 요약', '- 내용: 사람이 고친 설명')
    const prev = parseMap(md, 'docs/docs_map.md')
    const d = diffMap(prev, [{ path: 'docs/a.md', content: a }, { path: 'docs/b.md', content: b + '\n추가' }, { path: 'docs/c.md', content: '# C' }])
    expect(d.keep.map((x) => [x.path, x.summary])).toEqual([['docs/a.md', '사람이 고친 설명']])
    expect(d.stale.map((x) => x.path)).toEqual(['docs/b.md', 'docs/c.md'])
    expect(diffMap(prev, [{ path: 'docs/a.md', content: a }]).removed).toBe(1)
  })

  it('AI 설명에 실패한 문서는 정해진 횟수까지만 다시 시도한다', () => {
    const a = '# A'
    const failed = { ...e('docs/a.md', a), fails: 1 }
    const md = renderMap([failed], 'docs/docs_map.md')
    expect(md).toContain(';fails=1')
    const back = parseMap(md, 'docs/docs_map.md')
    expect(back[0].fails).toBe(1)
    expect(diffMap(back, [{ path: 'docs/a.md', content: a }]).stale.map((x) => x.fails)).toEqual([1])
    const gaveUp = parseMap(renderMap([{ ...failed, fails: 2 }], 'docs/docs_map.md'), 'docs/docs_map.md')
    expect(diffMap(gaveUp, [{ path: 'docs/a.md', content: a }]).stale).toEqual([])
    // 내용이 바뀌면 횟수를 초기화하고 다시 만든다
    expect(diffMap(gaveUp, [{ path: 'docs/a.md', content: a + '!' }]).stale.map((x) => x.fails)).toEqual([0])
  })

  it('코드 블록 안의 # 줄은 섹션으로 보지 않는다', () => {
    expect(headingsOf('## 하나\n```\n## 코드\n```\n### 둘')).toEqual(['하나', '둘'])
  })
})
