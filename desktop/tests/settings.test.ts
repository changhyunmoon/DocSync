import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { Settings } from '../src/main/settings'

describe('실제 프로젝트 복원', () => {
  let root = ''
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('이전 버전이 샘플을 마지막 경로로 저장해도 실제 프로젝트를 찾는다', async () => {
    root = await mkdtemp(join(tmpdir(), 'docsync-settings-'))
    env.userData = join(root, 'DocSync')
    await mkdir(env.userData)
    const real = join(root, 'my-project')
    const demo = join(env.userData, 'sample-project-v2')
    await writeFile(join(env.userData, 'settings.json'), JSON.stringify({ lastProject: demo, scopes: { [real]: ['docs'], [demo]: ['docs'] } }))
    const settings = new Settings()
    await settings.load()
    expect(settings.lastRealProject).toBe(real)
    await settings.saveProject(real, ['docs'])
    const reloaded = new Settings()
    await reloaded.load()
    expect(reloaded.lastRealProject).toBe(real)
  })
})
