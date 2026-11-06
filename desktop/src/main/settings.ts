// 앱을 다시 켜도 유지되는 설정: 마지막 프로젝트, 프로젝트별 반영 범위, 제공자별 API 키와 모델.
// API 키는 OS 보안 저장소(Windows: DPAPI, macOS: 키체인)로 암호화해서 저장한다.
import { app, safeStorage } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { Provider } from '@shared/types'

interface SavedKey {
  enc: string // 암호화된 키 (base64)
  tail: string
  model: string
  models: string[]
}

interface SettingsData {
  lastProject?: string
  lastRealProject?: string
  scopes?: Record<string, string[]>
  activeProvider?: Provider
  keys?: Partial<Record<Provider, SavedKey>>
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json')

export class Settings {
  private data: SettingsData = {}

  async load(): Promise<void> {
    // 테스트용: 키링이 없는 Linux 환경에서만, 명시적으로 켰을 때 약한 암호화를 허용
    if (process.platform === 'linux' && process.env.DOCSYNC_ALLOW_PLAIN_KEY_STORAGE === '1') safeStorage.setUsePlainTextEncryption(true)
    try {
      this.data = JSON.parse(await fsp.readFile(file(), 'utf8'))
    } catch {
      this.data = {}
    }
  }

  private async save(): Promise<void> {
    await fsp.mkdir(path.dirname(file()), { recursive: true })
    const tmp = file() + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await fsp.rename(tmp, file())
  }

  get canEncrypt(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  get lastProject(): string | undefined {
    return this.data.lastProject
  }

  /** 이전 버전이 샘플 경로를 마지막 프로젝트로 저장한 경우에도 실제 프로젝트를 복구한다. */
  get lastRealProject(): string | undefined {
    const candidates = [this.data.lastRealProject, this.data.lastProject, ...Object.keys(this.data.scopes ?? {}).reverse()]
    const userData = path.resolve(app.getPath('userData')).toLowerCase()
    return candidates.find((root): root is string => !!root && !(
      path.dirname(path.resolve(root)).toLowerCase() === userData && path.basename(root).toLowerCase().startsWith('sample-project')
    ))
  }

  scopeOf(root: string): string[] | undefined {
    return this.data.scopes?.[root]
  }

  async saveProject(root: string, scope: string[]): Promise<void> {
    this.data.lastProject = root
    this.data.lastRealProject = root
    this.data.scopes = { ...(this.data.scopes ?? {}), [root]: scope }
    await this.save()
  }

  savedKeys(): { provider: Provider; tail: string }[] {
    return Object.entries(this.data.keys ?? {}).map(([provider, k]) => ({ provider: provider as Provider, tail: (k as SavedKey).tail }))
  }

  get activeProvider(): Provider | undefined {
    return this.data.activeProvider
  }

  /** 저장된 키를 복호화해서 돌려준다 (복호화 실패 시 null) */
  getKey(provider: Provider): { apiKey: string; model: string; models: string[] } | null {
    const k = this.data.keys?.[provider]
    if (!k || !this.canEncrypt) return null
    try {
      return { apiKey: safeStorage.decryptString(Buffer.from(k.enc, 'base64')), model: k.model, models: k.models }
    } catch {
      return null
    }
  }

  async saveKey(provider: Provider, apiKey: string, model: string, models: string[]): Promise<boolean> {
    if (!this.canEncrypt) return false
    const enc = safeStorage.encryptString(apiKey).toString('base64')
    this.data.keys = { ...(this.data.keys ?? {}), [provider]: { enc, tail: apiKey.slice(-4), model, models } }
    this.data.activeProvider = provider
    await this.save()
    return true
  }

  async setActive(provider: Provider | undefined): Promise<void> {
    this.data.activeProvider = provider
    await this.save()
  }

  async removeKey(provider: Provider): Promise<void> {
    if (this.data.keys) delete this.data.keys[provider]
    if (this.data.activeProvider === provider) this.data.activeProvider = undefined
    await this.save()
  }
}
