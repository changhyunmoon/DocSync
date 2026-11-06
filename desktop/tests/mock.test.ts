import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Session } from '../src/main/session'
import { DEMO_FILES, SAMPLE_TEXT } from '../src/main/mock'
import { isChange } from '@shared/review'

describe('테스트 모드 흐름', () => {
  let root = ''
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('키 없이 예시 변경안을 만들고 기존 반영 엔진으로 저장·되돌린다', async () => {
    root = await mkdtemp(join(tmpdir(), 'docsync-mock-'))
    for (const [path, content] of Object.entries(DEMO_FILES)) {
      const full = join(root, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content)
    }
    const session = new Session(() => {}, () => {})
    await session.openProject(root)
    expect(session.publicState().testMode).toBe(true)
    expect((await session.send({ text: SAMPLE_TEXT, attachments: [], selectedItemId: null })).ok).toBe(true)
    expect(Object.keys(DEMO_FILES).length).toBeGreaterThanOrEqual(10)
    expect(session.items).toHaveLength(6)
    expect(session.items.slice(0, 4).every((item) => item.status === 'pending' && item.evidence.length > 0 && item.mappings.length >= 4)).toBe(true)
    // 신규·보완·충돌·중복·판단 필요가 모두 들어 있다
    const relations = new Set(session.items.flatMap((item) => item.mappings.map((m) => m.relation)))
    expect([...relations].sort()).toEqual(['중복', '보완', '신규', '충돌', '판단 필요'].sort())
    expect(session.items[4].status).toBe('confirmed')
    expect(session.items[5].status).toBe('excluded')
    // 테스트 모드에서 판단 필요 파일의 대상을 정하면 그 파일만 채우고 다른 파일 변경안은 그대로 둔다
    const third = session.items[2]
    const unknown = third.mappings.find((m) => m.relation === '판단 필요')!
    const before = third.mappings.filter((m) => m !== unknown).map((m) => m.newText)
    expect((await session.setMappingFile(third.id, unknown.id, 'docs/security/data-retention.md')).ok).toBe(true)
    expect(unknown.relation).toBe('신규')
    expect(third.mappings.filter((m) => m !== unknown).map((m) => m.newText)).toEqual(before)
    expect(session.messages.at(-1)?.mock).toBe(true)
    const first = session.items[0]
    expect(first.mappings).toHaveLength(5)
    expect((await session.previews(first.id)).every((preview) => preview.valid)).toBe(true)
    expect((await session.itemAction(first.id, 'approve')).ok).toBe(true)
    expect((await session.applyItems([first.id])).ok).toBe(true)
    for (const mapping of first.mappings.filter(isChange)) {
      expect(await readFile(join(root, mapping.file!), 'utf8')).toContain(mapping.newText)
    }
    expect((await session.itemAction(first.id, 'undo')).ok).toBe(true)
    for (const mapping of first.mappings.filter(isChange)) {
      expect(await readFile(join(root, mapping.file!), 'utf8')).toBe(DEMO_FILES[mapping.file!])
    }
    for (const item of session.items.slice(0, 4)) {
      expect((await session.previews(item.id)).every((preview) => preview.valid)).toBe(true)
      expect((await session.itemAction(item.id, 'approve')).ok).toBe(true)
    }
    expect((await session.applyAllApproved()).ok).toBe(true)
    expect(session.items.slice(0, 4).every((item) => item.status === 'applied')).toBe(true)
    for (const item of session.items.slice(0, 4)) {
      for (const mapping of item.mappings.filter(isChange)) {
        expect(await readFile(join(root, mapping.file!), 'utf8')).toContain(mapping.newText)
      }
    }
    const realSession = new Session(() => {}, () => {})
    realSession.testMode = false
    await realSession.openProject(root)
    expect((await realSession.send({ text: '실제 모드', attachments: [], selectedItemId: null })).message).toBe('need-key')
    expect(session.items).toHaveLength(6)
  })
})
