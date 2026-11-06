import { describe, expect, it } from 'vitest'
import { extractLinks, planMove } from '../src/main/core/links'
import { buildSegments, locateQuote } from '@shared/text'

describe('links', () => {
  it('링크·이미지·정의의 URL 위치를 찾는다', () => {
    const md = '[a](auth/login.md) ![img](./img/x.png "t")\n\n[ref]: ../b.md\n[web](https://x.com)'
    const refs = extractLinks(md).map((r) => r.raw)
    expect(refs).toEqual(expect.arrayContaining(['auth/login.md', './img/x.png', '../b.md', 'https://x.com']))
  })

  it('이동 시 다른 문서의 링크와 이동 파일 내부 링크를 고친다', () => {
    const docs = {
      'docs/README.md': '- [로그인](auth/login.md#실패)\n- [세션](auth/session.md)\n',
      'docs/guides/onboarding.md': '[정책](../auth/login.md)\n',
      'docs/auth/login.md': '[세션](session.md) ![그림](../img/a.png) [가이드](../guides/onboarding.md)\n본문 docs/auth/login.md'
    }
    const plan = planMove([['docs/auth/login.md', 'docs/security/login.md']], docs)
    const get = (p: string) => plan.edits.find((e) => e.path === p)
    expect(get('docs/README.md')?.newContent).toBe('- [로그인](security/login.md#실패)\n- [세션](auth/session.md)\n')
    expect(get('docs/guides/onboarding.md')?.newContent).toBe('[정책](../security/login.md)\n')
    const moved = get('docs/auth/login.md')
    expect(moved?.newPath).toBe('docs/security/login.md')
    expect(moved?.newContent).toContain('[세션](../auth/session.md)')
    expect(moved?.newContent).toContain('![그림](../img/a.png)')
    expect(moved?.newContent).toContain('[가이드](../guides/onboarding.md)')
  })

  it('함께 이동하는 파일끼리의 링크는 그대로 둔다', () => {
    const docs = { 'docs/auth/login.md': '[세션](session.md)', 'docs/auth/session.md': '# 세션' }
    const plan = planMove([['docs/auth/login.md', 'docs/security/login.md'], ['docs/auth/session.md', 'docs/security/session.md']], docs)
    expect(plan.edits.find((e) => e.path === 'docs/auth/login.md')?.newContent).toBe('[세션](session.md)')
  })

  it('본문 경로 표현은 안내만 한다', () => {
    const plan = planMove([['docs/a.md', 'docs/b.md']], { 'docs/a.md': '', 'docs/c.md': '경로는 docs/a.md 참고' })
    expect(plan.notes.length).toBe(1)
    expect(plan.edits.find((e) => e.path === 'docs/c.md')).toBeUndefined()
  })
})

describe('text', () => {
  it('공백 차이를 무시하고 근거를 찾는다', () => {
    const t = '로그인을  5회\n연속 실패하면 잠근다.'
    const r = locateQuote(t, '로그인을 5회 연속 실패하면')
    expect(r).not.toBeNull()
    expect(t.slice(r![0], r![1])).toBe('로그인을  5회\n연속 실패하면')
  })

  it('겹치는 근거를 조각으로 나눈다', () => {
    const segs = buildSegments('abcdefgh', [{ start: 1, end: 5, itemId: 'x' }, { start: 3, end: 7, itemId: 'y' }])
    expect(segs.map((s) => [s.text, s.itemIds.join()])).toEqual([['a', ''], ['bc', 'x'], ['de', 'x,y'], ['fg', 'y'], ['h', '']])
  })
})

import { describeAiError, isHardQuota } from '../src/main/ai/client'
describe('ai errors', () => {
  const quota = Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. limit: 0, model: gemini-3.1-pro Please retry in 19h37m"}}'), { status: 429 })
  const burst = Object.assign(new Error('Resource exhausted. Please try again later.'), { status: 429 })
  it('하루 한도·무료 등급 0 한도는 재시도 대상이 아니다', () => {
    expect(isHardQuota(quota)).toBe(true)
    expect(isHardQuota(burst)).toBe(false)
    expect(describeAiError(quota, 'gemini-3.1-pro')).toContain('다른 모델')
  })
})

import { extractJson } from '../src/main/ai/client'
describe('extractJson', () => {
  it('추론 태그·코드 블록을 걷어내고 JSON을 꺼낸다', () => {
    expect(extractJson('<think>{"x":0}</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('결과입니다: {"a":{"b":2}} 끝')).toEqual({ a: { b: 2 } })
  })
})
