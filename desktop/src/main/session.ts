// 현재 앱 실행 동안만 유지되는 작업 상태와 모든 동작. 디스크에는 실제 프로젝트 파일만 쓴다.
import * as path from 'node:path'
const path_posix = path.posix
import type {
  ActionResult, ChatMessage, Evidence, Item, ItemStatus, Mapping, MappingPreview, Provider, PublicState, SourceDoc, TreeNode
} from '@shared/types'
import { locateQuote, existsAlready } from '@shared/text'
import { ProjectFs, inScope } from './core/projectFs'
import { applyItem, applyText, checkMapping, isChange, undoItem, describeProblem, editApplied, removeAppended, countOccurrences, type ApplyRecord } from './core/engine'
import { planMove } from './core/links'
import { FILE_REVIEWABLE, isActiveChange, mappingSig, syncItemStatus } from '@shared/review'
import { mapPathOf, isMapFile, parseMap, renderMap, diffMap, headingsOf, localSummary, mapForPrompt, type MapEntry } from './core/docsMap'
import { listModels, modelCandidates, probeModel, describeAiError, errorDetail, contextBudget, isTooLarge, type AiConfig } from './ai/client'
import { analyze, route, refine, analyzeAgent, refineAgent, summarizeDocs, selectDocs, type AnalyzeResult, type DocContext, type ExistingItemBrief, type AgentContext } from './ai/pipeline'
import { ToolsUnsupported } from './ai/agent'
import { folderTree, projectTools } from './core/projectTools'
import type { z } from 'zod'
import type { MappingOut } from './ai/pipeline'
import { sampleDrafts, type MockDraft } from './mock'

/** 변경안을 직접 고칠 수 있는 상태 (반영된 항목은 파일을 바로 고친다) */
const EDITABLE: string[] = ['pending', 'approved', 'rereview', 'excluded', 'held']

const STALE_REASON = '앞선 반영이나 파일 수정으로 기준 내용이 바뀌었습니다. 변경안을 다시 계산하세요.'

type MappingOutT = z.infer<typeof MappingOut>

export class Session {
  fs: ProjectFs | null = null
  scope: string[] = []
  sources: SourceDoc[] = []
  items: Item[] = []
  messages: ChatMessage[] = []
  records = new Map<string, ApplyRecord>()
  /** 이번 실행에서 앱이 새로 만든 파일 (되돌리기로 내용이 비면 파일도 지운다) */
  private createdPaths = new Set<string>()
  key: { provider: Provider; apiKey: string; model: string; models: string[] } | null = null
  processing = false
  processingLabel = ''
  savedKeys: { provider: Provider; tail: string }[] = []
  keyPersist = false
  testMode = true
  private abort: AbortController | null = null
  private seq = 0
  private itemNo = 0
  private order = 0

  constructor(
    private emit: (s: PublicState) => void,
    private toast: (m: string) => void
  ) {}

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`
  }

  publicState(): PublicState {
    return {
      root: this.fs?.root ?? null,
      rootName: this.fs ? path.basename(this.fs.root) : '',
      scope: this.scope,
      sources: this.sources,
      items: this.items,
      messages: this.messages,
      processing: this.processing,
      processingLabel: this.processingLabel,
      key: this.key ? { provider: this.key.provider, tail: this.key.apiKey.slice(-4), model: this.key.model, models: this.key.models } : null,
      savedKeys: this.savedKeys,
      keyPersist: this.keyPersist,
      testMode: this.testMode
    }
  }

  changed(): void {
    this.emit(this.publicState())
  }

  private say(text: string, error = false, detail?: string): void {
    this.messages.push({ id: this.id('m'), role: 'ai', text, error, detail })
  }

  private item(id: string): Item | undefined {
    return this.items.find((i) => i.id === id)
  }

  // ───────── 프로젝트 ─────────

  async openProject(root: string, savedScope?: string[]): Promise<void> {
    this.fs = new ProjectFs(root)
    this.sources = []
    this.items = []
    this.messages = []
    this.records.clear()
    this.itemNo = 0
    this.order = 0
    const kept: string[] = []
    for (const s of savedScope ?? []) if (await this.fs.exists(s)) kept.push(s)
    this.scope = savedScope ? kept : (await this.fs.exists('docs')) ? ['docs'] : []
    this.changed()
  }

  /** 저장된 키를 검증 없이 다시 불러온다 (앱 시작·제공자 전환 시) */
  restoreKey(provider: Provider, apiKey: string, model: string, models: string[]): void {
    this.key = { provider, apiKey, model, models }
    this.changed()
  }

  async tree(): Promise<TreeNode[]> {
    return this.fs ? this.fs.tree() : []
  }

  toggleScope(p: string): ActionResult {
    if (this.scope.includes(p)) this.scope = this.scope.filter((s) => s !== p)
    else this.scope = [...this.scope.filter((s) => !s.startsWith(p + '/')), p]
    this.changed()
    return { ok: true, message: this.scope.length ? `반영 범위: ${this.scope.join(', ')}` : '반영 범위: 프로젝트 전체' }
  }

  async writeFile(p: string, content: string, base?: string | null): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트를 먼저 여세요.' }
    if (typeof base === 'string') {
      const cur = await this.fs.read(p)
      if (cur !== null && cur !== base) {
        return { ok: false, conflict: true, message: `${p}: 편집하는 동안 다른 곳(항목 반영·외부 편집기 등)에서 파일이 바뀌어 저장하지 않았습니다.` }
      }
    }
    await this.fs.write(p, content)
    await this.revalidate()
    return { ok: true, message: `${p} 저장됨` }
  }

  async createEntry(p: string, dir: boolean): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트를 먼저 여세요.' }
    if (await this.fs.exists(p)) return { ok: false, message: '같은 이름이 이미 있습니다.' }
    if (dir) await this.fs.mkdir(p)
    else await this.fs.write(p, '')
    return { ok: true }
  }

  async deleteEntry(p: string): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트를 먼저 여세요.' }
    await this.fs.removeEntry(p)
    await this.revalidate()
    return { ok: true, message: `${p} 삭제됨` }
  }

  // ───────── API 키 ─────────

  async setKey(provider: Provider, apiKey: string): Promise<ActionResult> {
    const key = apiKey.trim()
    if (!key) return { ok: false, message: 'API 키를 입력하세요.' }
    try {
      const models = await listModels(provider, key)
      if (!models.length) return { ok: false, message: '사용 가능한 모델이 없습니다.' }
      const candidates = modelCandidates(provider, models)
      let model = ''
      for (const m of candidates.slice(0, 6)) {
        if (await probeModel({ provider, apiKey: key, model: m })) {
          model = m
          break
        }
      }
      this.key = { provider, apiKey: key, models, model: model || candidates[0] }
      this.changed()
      if (!model) return { ok: true, message: '키는 확인했지만 바로 쓸 수 있는 모델을 찾지 못했습니다. 모델 목록에서 직접 골라보세요.' }
      return { ok: true, message: `API 키를 확인했습니다 · 모델 ${model}` }
    } catch (e) {
      console.error(`[DocSync] API 키 확인 실패 (${provider})`, e)
      return { ok: false, message: `${describeAiError(e)}\n${errorDetail(e)}` }
    }
  }

  async setModel(model: string): Promise<ActionResult> {
    if (!this.key) return { ok: false }
    try {
      if (!(await probeModel({ provider: this.key.provider, apiKey: this.key.apiKey, model }))) {
        return { ok: false, message: `${model} 모델은 이 키로 사용할 수 없습니다. 다른 모델을 선택하세요.` }
      }
    } catch (e) {
      console.error(`[DocSync] 모델 확인 실패 (${model})`, e)
      return { ok: false, message: `${describeAiError(e, model)}\n${errorDetail(e)}` }
    }
    this.key.model = model
    this.changed()
    return { ok: true, message: `모델을 ${model}(으)로 바꿨습니다.` }
  }

  clearKey(): ActionResult {
    this.key = null
    this.changed()
    return { ok: true, message: 'API 키를 삭제했습니다.' }
  }

  private ai(): AiConfig | null {
    return this.key ? { provider: this.key.provider, apiKey: this.key.apiKey, model: this.key.model } : null
  }

  // ───────── 대화 ─────────

  stop(): ActionResult {
    this.abort?.abort()
    return { ok: true }
  }

  clearConversation(): ActionResult {
    if (this.processing) return { ok: false, message: 'AI 처리가 끝난 뒤 대화를 지우세요.' }
    this.sources = []
    this.items = []
    this.messages = []
    this.records.clear()
    this.createdPaths.clear()
    this.itemNo = 0
    this.order = 0
    this.changed()
    return { ok: true, message: '대화와 현재 작업을 지웠습니다.' }
  }

  private async begin<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.processing = true
    this.processingLabel = label
    this.abort = new AbortController()
    this.changed()
    try {
      return await fn(this.abort.signal)
    } catch (e) {
      const aborted = this.abort?.signal.aborted ?? false
      if (!aborted) console.error(`[DocSync] AI 요청 실패 (${this.key?.provider} · ${this.key?.model})`, e)
      this.say(describeAiError(e, this.key?.model), !aborted, aborted ? undefined : errorDetail(e))
      return undefined
    } finally {
      this.processing = false
      this.processingLabel = ''
      this.abort = null
      this.changed()
    }
  }

  async send(input: { text: string; attachments: { name: string; text: string }[]; selectedItemId: string | null }): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트 폴더를 먼저 여세요.' }
    if (this.processing) return { ok: false, message: '이전 요청을 처리하는 중입니다.' }
    if (this.testMode) return this.sendMock(input)
    const cfg = this.ai()
    if (!cfg) return { ok: false, message: 'need-key' }
    const text = input.text.trim()
    if (!text && !input.attachments.length) return { ok: false }

    const newSources: SourceDoc[] = input.attachments.map((a) => ({ id: this.id('s'), name: a.name, text: a.text }))
    const isMaterial = newSources.length > 0 || text.length >= 400 || text.split('\n').length >= 8
    let request = text
    if (isMaterial && !newSources.length) {
      newSources.push({ id: this.id('s'), name: `붙여넣은 자료 ${this.sources.length + 1}`, text })
      request = ''
    }
    this.sources.push(...newSources)
    this.messages.push({
      id: this.id('m'),
      role: 'user',
      text: newSources.length && !request ? (input.attachments.length ? '자료를 첨부했습니다.' : '자료를 붙여넣었습니다.') : text,
      attachments: newSources.map((s) => ({ sourceId: s.id, name: s.name }))
    })

    if (isMaterial) {
      await this.begin('자료 분석 중 · 항목 추출 → 문서 매핑 → 변경안 생성', (sig) => this.runAnalyze(cfg, request, newSources, sig))
      return { ok: true }
    }

    await this.begin('요청 이해 중', async (sig) => {
      const selected = input.selectedItemId ? this.item(input.selectedItemId) : undefined
      const r = await route(cfg, { message: text, files: await this.fs!.allFiles(), items: this.briefs(), selectedNo: selected?.no ?? null }, sig)
      if (r.intent === 'move') {
        if (!r.moves.length) return this.say(r.reply || '옮길 파일을 찾지 못했습니다.')
        const res = await this.proposeMovePairs(r.moves.map((m) => [m.from, m.to]))
        if (!res.ok) this.say(res.message ?? '이동 변경안을 만들 수 없습니다.', true)
        return
      }
      if (r.intent === 'refine') {
        const target = this.items.find((i) => i.no === r.itemNo) ?? selected
        if (!target) return this.say(r.reply || '어떤 항목을 고칠지 알 수 없습니다. 항목을 선택하고 다시 요청하세요.')
        this.processingLabel = `#${target.no} 변경안 다시 만드는 중`
        this.changed()
        await this.doRefine(cfg, target, r.instruction || text, sig)
        this.say(`#${target.no} 변경안을 갱신했습니다.${target.status === 'pending' ? '' : ''}`)
        return
      }
      if (r.intent === 'analyze') {
        const src: SourceDoc = { id: this.id('s'), name: `요청 ${this.sources.length + 1}`, text }
        this.sources.push(src)
        const last = this.messages[this.messages.length - 1]
        last.attachments = [{ sourceId: src.id, name: src.name }]
        this.processingLabel = '항목 추출 중'
        this.changed()
        await this.runAnalyze(cfg, '', [src], sig)
        return
      }
      this.say(r.reply)
    })
    return { ok: true }
  }

  private async sendMock(input: { text: string; attachments: { name: string; text: string }[] }): Promise<ActionResult> {
    const text = input.text.trim()
    if (!text && !input.attachments.length) return { ok: false }
    const sources = input.attachments.map((a) => ({ id: this.id('s'), name: a.name, text: a.text }))
    if (text) sources.push({ id: this.id('s'), name: input.attachments.length ? '요청 내용' : '입력 자료', text })
    this.sources.push(...sources)
    this.messages.push({ id: this.id('m'), role: 'user', text: text || '자료를 첨부했습니다.', attachments: sources.map((s) => ({ sourceId: s.id, name: s.name })) })
    this.processing = true
    this.processingLabel = '테스트 변경안 만드는 중'
    this.changed()
    try {
      await new Promise((resolve) => setTimeout(resolve, 450))
      const material = sources.map((s) => s.text).join('\n')
      const sample = material.includes('MarketFlow 회원가입 전환 및 인증 운영안 회의록')
      const candidates = sample ? sampleDrafts() : []
      const readyChecks = await Promise.all(candidates.flatMap((d) => d.mappings).map(async (m) => {
        if (!m.file) return true
        if (m.relation === '중복') return (await this.fs!.read(m.file))?.includes(m.existing ?? '') ?? false
        if (!m.oldText) return !(await this.fs!.exists(m.file))
        return (await this.fs!.read(m.file))?.includes(m.oldText) ?? false
      }))
      const ready = candidates.length > 0 && readyChecks.every(Boolean)
      const drafts = ready ? candidates : await this.genericMockDrafts(material)
      for (const d of drafts) {
        const source = sources.find((s) => s.text.includes(d.quote)) ?? sources[0]
        const span = source ? locateQuote(source.text, d.quote) : null
        const evidence: Evidence[] = source && span ? [{ sourceId: source.id, start: span[0], end: span[1], quote: d.quote }] : []
        this.items.push({
          id: this.id('i'), no: ++this.itemNo, kind: 'content', title: d.title, detail: d.detail,
          confirmed: d.confirmed !== false, status: d.confirmed === false ? 'excluded' : 'pending', evidence,
          mappings: d.mappings.map((m) => ({ id: this.id('mp'), file: m.file, section: m.section, relation: m.relation, reason: m.reason, existing: m.existing ?? m.oldText, oldText: m.oldText, newText: m.newText }))
        })
        // 문서에 이미 있는 내용만 있는 항목은 실제 분석처럼 "이미 존재"로 표시한다
        await this.markExisting(this.items[this.items.length - 1])
      }
      await this.revalidate(false)
      this.say(`회의록에서 ${drafts.length}개 항목을 정리했습니다. 결정된 내용은 문서별 변경안(신규·보완·충돌)에 연결했고, 문서에 이미 있는 내용은 "이미 존재"로, 알맞은 문서를 찾지 못한 부분은 "판단 필요"로, 미결 사항은 "미확정"으로 표시했습니다. 항목을 열어 파일마다 diff를 확인해 기존 유지·제안 채택·보류를 고른 뒤 반영해 보세요.\n\n테스트 모드의 예시 결과이며 AI가 분석한 내용은 아닙니다.`)
      this.messages[this.messages.length - 1].mock = true
      return { ok: true }
    } finally {
      this.processing = false
      this.processingLabel = ''
      this.changed()
    }
  }

  private async genericMockDrafts(material: string): Promise<MockDraft[]> {
    const files = (await this.fs!.allFiles()).filter((p) => ProjectFs.isMarkdown(p) && inScope(p, this.scope) && !isMapFile(p) && !/(?:^|\/)(?:README|index)\.md$/i.test(p))
    const lines = material.split(/\n|(?<=[.!?。])\s+/).map((s) => s.trim().replace(/^[-*•\d.)\s]+/, '')).filter((s) => s.length >= 12 && !s.startsWith('#')).slice(0, 3)
    const chosen = lines.length ? lines : [material.trim().slice(0, 200)]
    return chosen.map((line, i) => {
      const words = line.toLowerCase().match(/[가-힣]{2,}|[a-z]{3,}/g) ?? []
      const scored = files.map((file) => ({ file, score: words.reduce((n, w) => n + (file.toLowerCase().includes(w) ? 1 : 0), 0) }))
      scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      const file = scored[0]?.file ?? `docs/test-note-${i + 1}.md`
      const title = line.replace(/[.!?。]$/, '').slice(0, 32)
      return {
        title, detail: line, quote: line,
        mappings: [{ file, section: files.includes(file) ? '문서 끝에 추가' : '새 예시 문서', oldText: '',
          newText: `${files.includes(file) ? '\n' : ''}## ${title}\n${line}\n`, relation: '신규' as const,
          reason: files.includes(file) ? '입력 문구와 경로 이름이 가까운 문서에 예시 문구를 추가합니다.' : '반영 범위에 Markdown 문서가 없어 예시 문서를 만듭니다.' }]
      }
    })
  }

  private briefs(): ExistingItemBrief[] {
    return this.items.map((i) => ({
      no: i.no,
      title: i.title,
      detail: i.detail,
      status: i.status,
      confirmed: i.confirmed,
      mappings: i.mappings.map((m) => ({ file: m.file, relation: m.relation }))
    }))
  }

  /** 도구 호출을 지원하지 않는 것으로 확인된 모델 (문서를 미리 넣어 보내는 방식으로 대체) */
  private noTools = new Set<string>()

  private async agentContext(map?: string): Promise<AgentContext> {
    return {
      tree: await folderTree(this.fs!, this.scope),
      map,
      scope: this.scope,
      tools: projectTools(this.fs!, this.scope),
      onStep: (label) => {
        this.processingLabel = label
        this.changed()
      }
    }
  }

  /**
   * 프로젝트 탐색형(도구 사용)으로 먼저 시도하고, 모델이 도구를 지원하지 않으면
   * 문서를 미리 넣어 보내는 방식으로 대체한다.
   */
  private async explore<T>(agent: (ctx: AgentContext) => Promise<{ value: T; read: string[] }>, fallback: () => Promise<T>, map?: string): Promise<{ value: T; read: string[] | null }> {
    const key = this.budgetKey()
    if (!this.noTools.has(key)) {
      try {
        return await agent(await this.agentContext(map))
      } catch (e) {
        if (!(e instanceof ToolsUnsupported)) throw e
        this.noTools.add(key)
        console.warn(`[DocSync] ${key}: 도구 호출 미지원 → 문서를 함께 보내는 방식으로 대체`, e.message)
      }
    }
    return { value: await fallback(), read: null }
  }

  /** 모델별로 학습한 문서 분량 한도 (한도 초과 오류에서 알아낸 값) */
  private learnedBudget = new Map<string, number>()

  private budgetKey(): string {
    return `${this.key?.provider}:${this.key?.model}`
  }

  private currentBudget(): number {
    const base = contextBudget(this.key?.provider ?? 'Anthropic')
    return Math.min(base, this.learnedBudget.get(this.budgetKey()) ?? base)
  }

  /**
   * 문서 맥락을 붙여 AI를 호출한다. "요청이 너무 크다"는 오류가 오면
   * 오류에 담긴 한도(Limit)·요청량(Requested)으로 문서 분량을 줄여 두 번까지 다시 보낸다.
   */
  private async withDocs<T>(focus: string[], call: (docs: DocContext) => Promise<T>, extraChars = 0, opts: { map?: string; only?: boolean } = {}): Promise<T> {
    let budget = this.currentBudget()
    for (let attempt = 0; ; attempt++) {
      const docs = await this.docContext(focus, budget, opts)
      const used = docs.files.reduce((n, f) => n + (f.content?.length ?? 0), 0)
      try {
        return await call(docs)
      } catch (e) {
        if (!isTooLarge(e) || attempt >= 2) throw e
        const m = errorDetail(e).match(/Limit\D{0,3}(\d+)\D+Requested\D{0,3}(\d+)/i)
        let next: number
        if (m) {
          const limit = Number(m[1])
          const requested = Number(m[2])
          // 요청 전체에서 문서가 차지하는 비율로 문자/토큰 비율을 추정하고, 한도의 80%에 맞춘다
          const charsPerToken = Math.max(1, (used + extraChars + 4000) / requested)
          next = Math.floor(used - (requested - limit * 0.8) * charsPerToken)
        } else {
          next = Math.floor(used * 0.5)
        }
        if (used === 0 || next < 500) {
          throw Object.assign(new Error(`입력 자료와 지시문만으로도 ${this.key?.model}의 한도를 넘습니다. 자료를 나눠 보내거나 한도가 큰 모델을 선택하세요.\n${errorDetail(e)}`), { status: 413, userMessage: `입력 자료만으로도 ${this.key?.model}의 한도를 넘습니다. 자료를 나눠 보내거나 한도가 큰 모델을 선택하세요.` })
        }
        budget = Math.max(500, next)
        this.learnedBudget.set(this.budgetKey(), budget)
        console.warn(`[DocSync] 모델 한도 초과 → 문서 분량 ${used}자 → ${budget}자로 줄여 다시 요청`)
        this.processingLabel = `모델 한도에 맞게 문서 분량을 줄여 다시 요청 중 (${Math.round(budget / 1000)}천 자)`
        this.changed()
      }
    }
  }

  /** 반영 범위 문서 (지도 자체는 제외) */
  private async scopedDocs(): Promise<{ path: string; content: string }[]> {
    const all = await this.fs!.allFiles()
    const out: { path: string; content: string }[] = []
    for (const p of all.filter((x) => ProjectFs.isTextDoc(x) && inScope(x, this.scope) && !isMapFile(x))) {
      const c = await this.fs!.read(p)
      if (c != null) out.push({ path: p, content: c })
    }
    return out
  }

  /**
   * 문서 지도(docs_map.md)를 현재 문서에 맞춘다. 새로 생기거나 바뀐 문서만 AI로 설명을 만들고,
   * 내용이 그대로인 문서의 설명(사람이 고친 것 포함)은 유지한다.
   */
  private async syncMap(cfg: AiConfig, signal: AbortSignal, docs: { path: string; content: string }[]): Promise<MapEntry[]> {
    const mapPath = mapPathOf(this.scope)
    if (!docs.length) return []
    const prevText = await this.fs!.read(mapPath)
    const existing = prevText ? parseMap(prevText, mapPath) : []
    const { keep, stale, removed } = diffMap(existing, docs)
    if (!stale.length && !removed && prevText) return keep

    const made: MapEntry[] = []
    if (stale.length) {
      this.processingLabel = `문서 지도 갱신 중 · 문서 ${stale.length}개 설명 작성`
      this.changed()
      // 문서당 앞부분만 보내 설명을 만든다 (한 번에 보낼 분량을 넘으면 나눠 보낸다)
      const PER = 3500
      const cap = Math.max(4000, Math.min(this.currentBudget(), 40000))
      const batches: (typeof stale)[] = [[]]
      let used = 0
      for (const d of stale) {
        const n = Math.min(d.content.length, PER)
        if (used + n > cap && batches[batches.length - 1].length) {
          batches.push([])
          used = 0
        }
        batches[batches.length - 1].push(d)
        used += n
      }
      for (const b of batches) {
        if (signal.aborted) throw new Error('취소되었습니다.')
        let got = new Map<string, { kind: string; summary: string }>()
        try {
          const r = await summarizeDocs(cfg, b.map((d) => ({ path: d.path, content: d.content.slice(0, PER) })), signal)
          got = new Map(r.docs.map((x) => [x.path.replace(/\\/g, '/').replace(/^\.?\//, ''), x]))
        } catch (e) {
          if (signal.aborted) throw e
          console.warn('[DocSync] 문서 지도 설명 작성 실패 → 제목·첫 문단으로 대신', errorDetail(e))
        }
        for (const d of b) {
          const s = got.get(d.path)
          // AI 설명을 못 받은 문서는 임시 설명을 두고 실패 횟수를 기록한다 (한도까지만 다시 시도)
          const base = s?.summary ? { kind: s.kind, summary: s.summary } : localSummary(d.content)
          made.push({ path: d.path, kind: base.kind, summary: base.summary.slice(0, 200), sections: headingsOf(d.content), hash: d.hash, ...(s?.summary ? {} : { fails: d.fails + 1 }) })
        }
      }
    }
    const entries = [...keep, ...made]
    const text = renderMap(entries, mapPath)
    if (text !== prevText) {
      await this.fs!.write(mapPath, text)
      if (!prevText) this.say(`문서 지도 ${mapPath}를 만들었습니다 (문서 ${entries.length}개). 앞으로는 이 지도로 관련 문서만 골라 AI에 보냅니다. 설명은 직접 고쳐도 됩니다.`)
    }
    return entries
  }

  /** 분석 전 준비: 지도 갱신. 실패하면 지도 없이 예전 방식으로 진행 */
  private async prepareMap(cfg: AiConfig, signal: AbortSignal): Promise<{ map?: string; docs: { path: string; content: string }[] }> {
    const docs = await this.scopedDocs()
    try {
      const entries = await this.syncMap(cfg, signal, docs)
      return { map: entries.length ? mapForPrompt(entries) : undefined, docs }
    } catch (e) {
      if (signal.aborted) throw e
      console.warn('[DocSync] 문서 지도 준비 실패 → 지도 없이 진행', errorDetail(e))
      return { docs }
    }
  }

  /** 지도 파일을 갱신 없이 읽기만 (재생성 요청처럼 가벼운 호출용) */
  private async readMap(): Promise<string | undefined> {
    const mapPath = mapPathOf(this.scope)
    const t = await this.fs!.read(mapPath)
    if (!t) return undefined
    const e = parseMap(t, mapPath)
    return e.length ? mapForPrompt(e) : undefined
  }

  private async docContext(focus: string[] = [], budget = this.currentBudget(), opts: { map?: string; only?: boolean } = {}): Promise<DocContext> {
    const all = await this.fs!.allFiles()
    const docs = all.filter((p) => ProjectFs.isTextDoc(p) && inScope(p, this.scope) && !isMapFile(p))
    const ordered = [...focus.filter((f) => docs.includes(f)), ...docs.filter((d) => !focus.includes(d))]
    let used = 0
    const files: DocContext['files'] = []
    for (const p of ordered) {
      // 지도로 고른 문서만 본문을 넣는다
      if (opts.only && !focus.includes(p)) {
        files.push({ path: p, content: null })
        continue
      }
      const c = await this.fs!.read(p)
      if (c != null && used + c.length <= budget) {
        used += c.length
        files.push({ path: p, content: c })
      } else files.push({ path: p, content: null })
    }
    return { tree: await folderTree(this.fs!, this.scope), map: opts.map, scope: this.scope, files, outOfScope: all.filter((p) => !inScope(p, this.scope)) }
  }

  private toMappings(outs: MappingOutT[]): Mapping[] {
    // 일부 모델은 줄바꿈을 "\\n" 글자로 이중 이스케이프해서 돌려준다 → 실제 줄바꿈으로 되돌린다
    const unescape = (t: string): string => (t && !t.includes('\n') && t.includes('\\n') ? t.replace(/(?:\\r)?\\n/g, '\n').replace(/\\t/g, '\t') : t)
    const ms = outs.filter((raw) => !isMapFile(raw.file)).map((raw) => {
      const o = { ...raw, oldText: unescape(raw.oldText), newText: unescape(raw.newText), existing: unescape(raw.existing) }
      const noChange = o.relation === '중복' || o.relation === '판단 필요'
      const file = o.file ? o.file.replace(/\\/g, '/').replace(/^\.?\//, '') : null
      return {
        id: this.id('mp'),
        file,
        section: o.section,
        relation: o.relation,
        reason: o.reason,
        existing: o.existing,
        oldText: noChange ? '' : o.oldText,
        newText: noChange ? '' : o.newText,
        stale: null
      } satisfies Mapping
    })
    if (!ms.length) {
      ms.push({ id: this.id('mp'), file: null, section: '', relation: '판단 필요', reason: '적절한 대상 문서를 찾지 못했습니다.', existing: '', oldText: '', newText: '', stale: null })
    }
    return ms
  }

  private toEvidence(ev: { sourceId: string; quote: string }[], batch: SourceDoc[]): Evidence[] {
    const out: Evidence[] = []
    for (const e of ev) {
      const candidates = [this.sources.find((s) => s.id === e.sourceId), ...batch, ...this.sources].filter(Boolean) as SourceDoc[]
      for (const s of candidates) {
        const r = locateQuote(s.text, e.quote)
        if (r) {
          if (!out.some((x) => x.sourceId === s.id && x.start === r[0])) out.push({ sourceId: s.id, start: r[0], end: r[1], quote: s.text.slice(r[0], r[1]) })
          break
        }
      }
    }
    return out
  }

  private newItem(o: AnalyzeResult['items'][number], batch: SourceDoc[], note?: string): Item {
    const mappings = this.toMappings(o.mappings)
    return {
      id: this.id('i'),
      no: ++this.itemNo,
      kind: 'content',
      title: o.title,
      detail: o.detail,
      confirmed: o.confirmed,
      status: o.confirmed ? 'pending' : 'excluded',
      evidence: this.toEvidence(o.evidence, batch),
      mappings,
      conflictNote: note
    }
  }

  private async runAnalyze(cfg: AiConfig, request: string, batch: SourceDoc[], signal: AbortSignal): Promise<void> {
    const input = { request, sources: batch.map((s) => ({ id: s.id, name: s.name, text: s.text })), existing: this.briefs() }
    const { map, docs: scoped } = await this.prepareMap(cfg, signal)
    const extra = request.length + batch.reduce((n, s) => n + s.text.length, 0) + JSON.stringify(this.briefs()).length
    const { value: res, read } = await this.explore(
      (ctx) => analyzeAgent(cfg, input, ctx, signal),
      async () => {
        const total = scoped.reduce((n, d) => n + d.content.length, 0)
        // 문서가 적으면 고르는 호출 없이 모두 보낸다
        if (!map || total <= 12000) return this.withDocs([], (docs) => analyze(cfg, { ...input, docs }, signal), extra)
        this.processingLabel = '문서 지도에서 관련 문서 고르는 중'
        this.changed()
        let picked: string[]
        try {
          const live = new Set(scoped.map((d) => d.path))
          const r = await selectDocs(cfg, { request, sources: batch, existing: this.briefs(), map }, signal)
          picked = r.files.map((f) => f.replace(/\\/g, '/').replace(/^\.?\//, '')).filter((f) => live.has(f))
          // 기존 항목이 다루는 문서도 함께 (병합·충돌 판단용)
          for (const it of this.items) for (const m of it.mappings) if (m.file && live.has(m.file) && !picked.includes(m.file) && !['rejected', 'excluded'].includes(it.status)) picked.push(m.file)
          console.log(`[DocSync] 문서 지도로 고른 문서 ${picked.length}/${scoped.length}개:`, picked.join(', '), '·', r.reason)
        } catch (e) {
          if (signal.aborted) throw e
          console.warn('[DocSync] 관련 문서 고르기 실패 → 문서를 한도 안에서 모두 보냄', errorDetail(e))
          return this.withDocs([], (docs) => analyze(cfg, { ...input, docs }, signal), extra)
        }
        this.processingLabel = `관련 문서 ${picked.length}개로 항목 추출 중`
        this.changed()
        return this.withDocs(picked, (docs) => analyze(cfg, { ...input, docs }, signal), extra + map.length, { map, only: true })
      },
      map
    )
    const stat = { new: 0, same: 0, refine: 0, conflict: 0 }
    const touched: Item[] = []
    for (const o of res.items) {
      const target = o.merge.itemNo != null ? this.items.find((i) => i.no === o.merge.itemNo) : undefined
      const type = target ? o.merge.type : 'new'
      if (type === 'same' && target) {
        target.evidence.push(...this.toEvidence(o.evidence, batch))
        stat.same++
        continue
      }
      const frozen = target && (target.status === 'applied' || target.status === 'confirmed')
      if (type === 'refine' && target && !frozen) {
        const before = JSON.stringify(target.mappings.map((m) => [m.file, m.oldText, m.newText]))
        target.title = o.title
        target.detail = o.detail
        target.confirmed = o.confirmed
        target.evidence.push(...this.toEvidence(o.evidence, batch))
        if (o.mappings.length) target.mappings = this.toMappings(o.mappings)
        const after = JSON.stringify(target.mappings.map((m) => [m.file, m.oldText, m.newText]))
        if (before !== after && target.status === 'approved') target.status = 'pending'
        if (target.status === 'rejected' || target.status === 'held') target.status = 'pending'
        touched.push(target)
        stat.refine++
        continue
      }
      if (type === 'conflict' && target) {
        if (!frozen && (target.status === 'pending' || target.status === 'approved')) {
          target.status = 'rereview'
          target.rereviewReason = '추가 자료와 충돌합니다.'
        }
        target.conflictNote = `추가 자료와 충돌: ${o.merge.note}`
        const ni = this.newItem(o, batch, `#${target.no}과 충돌: ${o.merge.note}`)
        this.items.push(ni)
        touched.push(ni)
        stat.conflict++
        continue
      }
      // new (또는 이미 반영된 항목을 구체화하는 경우 → 현재 파일 기준 새 항목)
      const ni = this.newItem(o, batch, frozen && target ? `#${target.no} 반영 이후 추가 변경` : undefined)
      this.items.push(ni)
      touched.push(ni)
      stat.new++
    }
    for (const it of touched) await this.markExisting(it)
    await this.normalizeDependent()
    this.flagSharedNewFiles()
    await this.revalidate(false)
    const exist = touched.filter((i) => i.status === 'confirmed')
    const parts = [`새 항목 ${stat.new}`]
    if (exist.length) parts.push(`이미 존재 ${exist.length} (${exist.map((i) => '#' + i.no).join(', ')} · 문서에 같은 내용이 있어 변경하지 않음)`)
    if (stat.same) parts.push(`같은 내용 ${stat.same} (원문 근거 추가)`)
    if (stat.refine) parts.push(`구체화 ${stat.refine} (변경안 갱신)`)
    if (stat.conflict) parts.push(`충돌 ${stat.conflict} (재검토 필요)`)
    const excluded = this.items.filter((i) => i.status === 'excluded').length
    const readNote = read ? (read.length ? `\n참고한 문서 ${read.length}개: ${read.slice(0, 8).join(', ')}${read.length > 8 ? ' …' : ''}` : '\n문서를 읽지 않고 폴더 구조만 보고 판단했습니다.') : ''
    this.say(`${res.summary}\n\n${parts.join(' · ')}${excluded ? `\n미확정 항목 ${excluded}개는 기본 반영 대상에서 제외했습니다.` : ''}${readNote}`)
  }

  /**
   * AI가 "이미 문서에 있음(중복)"으로만 분류한 항목을 확인한다.
   * 기존 문구를 실제 문서에서 찾을 수 있을 때만 "이미 존재"로 자동 표시하고,
   * 못 찾으면 검토 대기로 두고 안내를 단다 (AI가 문구를 지어낸 경우 대비).
   */
  private async markExisting(it: Item): Promise<void> {
    if (it.status !== 'pending' || !it.confirmed || !existsAlready(it) || !this.fs) return
    const missing: string[] = []
    for (const m of it.mappings) {
      const content = await this.fs.read(m.file as string)
      if (content === null || !m.existing.trim() || !locateQuote(content, m.existing)) missing.push(m.file as string)
    }
    if (!missing.length) {
      it.status = 'confirmed'
      return
    }
    const note = `AI는 이미 있는 내용이라고 판단했지만 ${missing.join(', ')}에서 그 문구를 찾지 못했습니다. 문서를 열어 같은 의미인지 확인하세요.`
    it.notes = [...(it.notes ?? []).filter((n) => !n.startsWith('AI는 이미 있는 내용')), note]
  }

  /**
   * 다른 항목이 새로 쓰는 문구를 기준(oldText)으로 삼은 매핑을 "끝에 덧붙이기"로 바꾼다.
   * 그래야 항목들을 어떤 순서로 반영·되돌리기 해도 서로 막히지 않는다.
   */
  private async normalizeDependent(): Promise<void> {
    if (!this.fs) return
    const open = this.items.filter((i) => ['pending', 'approved', 'rereview', 'excluded'].includes(i.status))
    for (const it of open) {
      for (const m of it.mappings) {
        if (!m.file || m.moveTo || !m.oldText || !isChange(m)) continue
        const cur = await this.fs.read(m.file)
        if (cur !== null && cur.includes(m.oldText)) continue
        const dependsOnOther = open.some((o) => o !== it && o.mappings.some((x) => x.file === m.file && x.newText.includes(m.oldText)))
        if (!dependsOnOther || !m.newText.startsWith(m.oldText)) continue
        m.newText = m.newText.slice(m.oldText.length).replace(/^(\r?\n)+/, '')
        m.oldText = ''
        m.reason = `${m.reason} (다른 항목이 쓰는 내용에 의존하지 않도록 문서 끝에 덧붙이는 방식으로 바꿈)`
      }
    }
  }

  /** 서로 다른 항목이 같은 새 문서를 만들면(한 파일에 여러 주제) 표시해 둔다 */
  private flagSharedNewFiles(): void {
    const owners = new Map<string, Item[]>()
    for (const it of this.items) {
      if (!['pending', 'approved', 'rereview', 'excluded'].includes(it.status)) continue
      for (const m of it.mappings) {
        if (!m.file || m.moveTo || m.oldText !== '' || !isChange(m)) continue
        owners.set(m.file, [...(owners.get(m.file) ?? []), it])
      }
    }
    for (const [file, list] of owners) {
      const uniq = [...new Set(list)]
      if (uniq.length < 2) continue
      for (const it of uniq) {
        const others = uniq.filter((x) => x !== it).map((x) => `#${x.no}`).join(', ')
        const note = `${others} 항목도 같은 새 문서(${file})를 만듭니다. 한 파일에 한 주제만 두도록 위치를 바꾸거나 항목을 합치세요.`
        if (!it.conflictNote?.includes(file)) it.conflictNote = it.conflictNote ? `${it.conflictNote}\n${note}` : note
      }
    }
  }

  private async doRefine(cfg: AiConfig, it: Item, instruction: string, signal: AbortSignal): Promise<void> {
    const focus = it.mappings.map((m) => m.file).filter(Boolean) as string[]
    const item = {
      no: it.no,
      title: it.title,
      detail: it.detail,
      evidence: it.evidence.map((e) => e.quote),
      mappings: it.mappings.map((m) => ({ file: m.file, section: m.section, relation: m.relation, oldText: m.oldText, newText: m.newText }))
    }
    const map = await this.readMap()
    const { value: r } = await this.explore(
      (ctx) => refineAgent(cfg, { item, instruction }, ctx, signal),
      () =>
        this.withDocs(focus, (docs) => refine(cfg, { item, instruction, docs }, signal), instruction.length + it.evidence.reduce((n, e) => n + e.quote.length, 0) + JSON.stringify(it.mappings).length + (map?.length ?? 0), {
          map,
          only: !!map && focus.length > 0
        }),
      map
    )
    it.title = r.title
    it.detail = r.detail
    it.mappings = this.toMappings(r.mappings)
    await this.normalizeDependent()
    if (it.status === 'approved' || it.status === 'rereview') it.status = 'pending'
    it.rereviewReason = undefined
    await this.markExisting(it)
    await this.revalidate(false)
  }

  async regenerate(id: string, instruction?: string): Promise<ActionResult> {
    const it = this.item(id)
    if (!it) return { ok: false }
    if (it.status === 'applied') return { ok: false, message: '반영된 항목은 되돌린 뒤 다시 계산하세요.' }
    if (this.testMode && it.kind === 'content') {
      if (instruction?.trim()) {
        it.detail = instruction.trim()
        for (const m of it.mappings) m.newText = m.oldText ? `${m.oldText}\n${instruction.trim()}` : `\n## ${it.title}\n${instruction.trim()}\n`
      }
      it.status = 'pending'
      it.rereviewReason = undefined
      await this.revalidate()
      return { ok: true, message: '테스트 변경안을 현재 문서 기준으로 갱신했습니다.' }
    }
    if (it.kind === 'move') {
      const pairs = it.mappings.filter((m) => m.moveTo).map((m) => [m.file as string, m.moveTo as string] as [string, string])
      const plan = await this.buildMove(pairs)
      if (!plan.ok) return { ok: false, message: plan.message }
      it.mappings = plan.mappings
      it.notes = plan.notes
      it.status = 'pending'
      it.rereviewReason = undefined
      await this.revalidate()
      return { ok: true, message: '현재 파일 기준으로 이동 변경안을 다시 계산했습니다.' }
    }
    const cfg = this.ai()
    if (!cfg) return { ok: false, message: 'need-key' }
    if (this.processing) return { ok: false, message: '다른 요청을 처리하는 중입니다.' }
    let ok = false
    await this.begin(`#${it.no} 변경안 다시 계산 중`, async (sig) => {
      await this.doRefine(cfg, it, instruction || '현재 파일 내용을 기준으로 변경안을 다시 계산하세요. 원래 의도는 유지합니다.', sig)
      ok = true
    })
    return ok ? { ok: true, message: `#${it.no} 변경안을 다시 계산했습니다. 파일마다 다시 확인하세요.` } : { ok: false }
  }

  // ───────── 이동 ─────────

  private async buildMove(pairs: [string, string][]): Promise<{ ok: true; mappings: Mapping[]; notes: string[] } | { ok: false; message: string }> {
    const fs = this.fs!
    const clean = pairs.map(([a, b]) => [a.replace(/\\/g, '/').replace(/^\.?\//, ''), b.replace(/\\/g, '/').replace(/^\.?\//, '')] as [string, string])
    for (const [a, b] of clean) {
      if ((await fs.read(a)) === null) return { ok: false, message: `${a} 파일이 없습니다.` }
      if (await fs.exists(b)) return { ok: false, message: `${b} 위치에 이미 파일이 있습니다.` }
      if (a === b) return { ok: false, message: '이동 전후 경로가 같습니다.' }
    }
    const all = await fs.allFiles()
    const docs: Record<string, string> = {}
    for (const p of all) {
      if (!ProjectFs.isMarkdown(p) && !clean.some(([a]) => a === p)) continue
      const c = await fs.read(p)
      if (c != null) docs[p] = c
    }
    const plan = planMove(clean, docs)
    const mappings: Mapping[] = []
    for (const [a, b] of clean) {
      const e = plan.edits.find((x) => x.path === a)
      const content = docs[a]
      mappings.push({
        id: this.id('mp'), file: a, moveTo: b, section: '', relation: '이동',
        reason: e && e.changedLinks ? `경로 변경 · 파일 안 상대 링크 ${e.changedLinks}개 수정` : '경로 변경',
        existing: '', oldText: content, newText: e ? e.newContent : content, stale: null
      })
    }
    for (const e of plan.edits) {
      if (clean.some(([a]) => a === e.path)) continue
      if (isMapFile(e.path)) continue // 문서 지도는 다음 분석 때 새 경로로 다시 맞춰진다
      mappings.push({
        id: this.id('mp'), file: e.path, section: '', relation: '링크 수정',
        reason: `이동하는 문서를 가리키는 상대 링크 ${e.changedLinks}개 수정`,
        existing: '', oldText: e.oldContent, newText: e.newContent, stale: null
      })
    }
    return { ok: true, mappings, notes: plan.notes }
  }

  private async proposeMovePairs(pairs: [string, string][]): Promise<ActionResult> {
    const plan = await this.buildMove(pairs)
    if (!plan.ok) return { ok: false, message: plan.message }
    const moved = plan.mappings.filter((m) => m.moveTo)
    const links = plan.mappings.filter((m) => m.relation === '링크 수정')
    const it: Item = {
      id: this.id('i'),
      no: ++this.itemNo,
      kind: 'move',
      title: moved.length === 1 ? `${moved[0].file} → ${moved[0].moveTo}` : `문서 ${moved.length}개 이동 → ${path.posix.dirname(moved[0].moveTo as string)}/`,
      detail: `경로 변경 ${moved.length}건 · 다른 문서의 링크 수정 ${links.length}건`,
      confirmed: true,
      status: 'pending',
      evidence: [],
      mappings: plan.mappings,
      notes: plan.notes
    }
    this.items.push(it)
    this.say(`이동 변경안 #${it.no}을 만들었습니다.\n· ${it.detail}${plan.notes.length ? `\n· 자동 수정하지 않는 경로 표현 ${plan.notes.length}건은 항목에서 확인하세요.` : ''}\n제안 채택 후 반영하면 이동과 링크 수정을 함께 적용합니다.`)
    this.changed()
    return { ok: true, message: `이동 변경안 #${it.no}을 만들었습니다.` }
  }

  async proposeMove(from: string, to: string): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트를 먼저 여세요.' }
    const all = await this.fs.allFiles()
    let pairs: [string, string][]
    if (all.includes(from)) pairs = [[from, to]]
    else {
      const inner = all.filter((p) => p.startsWith(from + '/'))
      if (!inner.length) return { ok: false, message: '빈 폴더는 바로 이름을 바꿀 수 없습니다.' }
      pairs = inner.map((p) => [p, to + p.slice(from.length)])
    }
    this.messages.push({ id: this.id('m'), role: 'user', text: `${from} → ${to} (이름 변경)` })
    return this.proposeMovePairs(pairs)
  }

  // ───────── 검토·반영 ─────────

  /** 현재 파일 기준으로 아직 반영 안 된 항목의 변경안이 유효한지 확인 */
  async revalidate(emit = true): Promise<void> {
    if (!this.fs) return
    for (const it of this.items) {
      if (!['pending', 'approved', 'rereview'].includes(it.status)) continue
      let bad = false
      for (const m of it.mappings) {
        // 기존 유지·보류한 파일은 반영하지 않으므로 기준이 바뀌어도 상관없다
        if (!isActiveChange(m)) {
          m.stale = null
          continue
        }
        const content = await this.fs.read(m.file as string)
        const targetExists = m.moveTo ? await this.fs.exists(m.moveTo) : false
        m.stale = checkMapping(m, content, targetExists)
        if (m.stale) bad = true
      }
      if (bad && it.status !== 'rereview') {
        it.status = 'rereview'
        it.rereviewReason = STALE_REASON
      } else if (!bad && it.status === 'rereview' && it.rereviewReason === STALE_REASON) {
        it.status = 'pending'
        it.rereviewReason = undefined
      }
    }
    if (emit) this.changed()
  }

  async itemAction(id: string, action: string): Promise<ActionResult> {
    const it = this.item(id)
    if (!it) return { ok: false }
    const set = (s: ItemStatus): void => {
      it.status = s
    }
    let msg: string | undefined
    switch (action) {
      case 'approve':
      case 'adopt': {
        await this.revalidate(false)
        if (it.status === 'rereview' && it.rereviewReason === STALE_REASON) {
          msg = '기준 내용이 바뀌어 채택할 수 없습니다. 변경안을 다시 계산하세요.'
          break
        }
        if (!it.mappings.some(isChange)) {
          msg = '파일 변경이 없는 항목입니다. 대상을 지정하거나 기존 반영을 확인하세요.'
          break
        }
        if (!it.mappings.some(isActiveChange)) {
          msg = '모든 파일을 기존 유지·보류로 결정한 항목입니다. 채택할 파일의 결정을 먼저 바꾸세요.'
          break
        }
        // 항목 전체 채택 = 기존 유지·보류하지 않은 파일을 모두 제안 채택
        for (const m of it.mappings) if (isActiveChange(m)) m.approvedSig = mappingSig(m)
        msg = syncItemStatus(it)
        break
      }
      case 'reject':
        set('rejected')
        break
      case 'keep':
        set('rejected')
        msg = '모든 파일을 기존 유지로 처리했습니다.'
        break
      case 'hold':
        set('held')
        msg = '보류했습니다.'
        break
      case 'unapprove':
        // 채택 취소: 제안 채택만 풀고, 기존 유지·보류 결정은 그대로 둔다
        for (const m of it.mappings) m.approvedSig = undefined
        set('pending')
        it.rereviewReason = undefined
        await this.revalidate(false)
        break
      case 'restore':
        // 다시 검토: 파일별 결정도 처음부터
        for (const m of it.mappings) {
          m.approvedSig = undefined
          m.rejected = undefined
          m.held = undefined
        }
        set('pending')
        it.rereviewReason = undefined
        await this.revalidate(false)
        break
      case 'include':
        set('pending')
        await this.revalidate(false)
        break
      case 'confirmDup':
        set('confirmed')
        msg = '이미 존재하는 내용으로 표시했습니다.'
        break
      case 'undo':
        return this.undo(it)
    }
    this.changed()
    return { ok: true, message: msg }
  }

  /**
   * 매핑된 파일 하나를 결정한다: 제안 채택(adopt) · 기존 유지(keep) · 보류(hold) · 결정 취소(reset).
   * 제안 채택은 diff에서 직접 고친 내용까지 그대로 채택한다. 파일 결정에 맞춰 항목 상태도 정한다.
   */
  async fileAction(itemId: string, mappingId: string, action: string): Promise<ActionResult> {
    const it = this.item(itemId)
    const m = it?.mappings.find((x) => x.id === mappingId)
    if (!it || !m || !this.fs) return { ok: false }
    if (!isChange(m)) return { ok: false, message: '파일 변경이 없는 매핑입니다.' }
    if (!FILE_REVIEWABLE.includes(it.status)) return { ok: false, message: '반영 전인 항목에서만 파일별로 결정할 수 있습니다.' }
    switch (action) {
      case 'adopt': {
        const stale = checkMapping(m, await this.fs.read(m.file as string), m.moveTo ? await this.fs.exists(m.moveTo) : false)
        if (stale) return { ok: false, message: `${describeProblem(stale, m.file as string)} 변경안을 다시 계산하거나 기존 유지·보류를 선택하세요.` }
        const outside = [m.file, m.moveTo].filter((p): p is string => !!p && !inScope(p, this.scope))
        if (it.kind === 'content' && outside.length) return { ok: false, message: `반영 범위 밖 파일이라 채택할 수 없습니다: ${outside.join(', ')} · 기존 유지나 보류를 선택하세요.` }
        m.rejected = undefined
        m.held = undefined
        m.approvedSig = mappingSig(m)
        break
      }
      case 'keep':
      case 'hold':
        m.rejected = action === 'keep' ? true : undefined
        m.held = action === 'hold' ? true : undefined
        m.approvedSig = undefined
        break
      case 'reset':
        m.rejected = undefined
        m.held = undefined
        m.approvedSig = undefined
        break
      default:
        return { ok: false }
    }
    let msg: string | undefined
    await this.revalidate(false)
    // 범위 밖 파일 때문에 재검토였는데 그 파일을 기존 유지·보류했다면 재검토 사유도 푼다
    if (it.status === 'rereview' && it.rereviewReason?.startsWith('반영 범위 밖') && !it.mappings.some((x) => isActiveChange(x) && !inScope(x.file as string, this.scope))) {
      it.status = 'pending'
      it.rereviewReason = undefined
    }
    // 기준이 바뀐 파일이 남아 있으면 재검토 상태를 유지한다
    if (!it.mappings.some((x) => isActiveChange(x) && x.stale)) msg = syncItemStatus(it)
    this.changed()
    return { ok: true, message: msg }
  }

  async editMapping(itemId: string, mappingId: string, newText: string): Promise<ActionResult> {
    const it = this.item(itemId)
    const m = it?.mappings.find((x) => x.id === mappingId)
    if (!it || !m) return { ok: false }
    if (it.status === 'applied') return this.editAppliedMapping(it, m, newText)
    if (!EDITABLE.includes(it.status)) return { ok: false, message: '기존 유지·이미 존재로 결정한 항목은 고칠 수 없습니다. 파일 결정을 먼저 취소하세요.' }
    m.newText = newText
    let msg: string | undefined
    if (it.status === 'approved') {
      it.status = 'pending'
      msg = '내용이 바뀌어 이 파일의 채택이 풀렸습니다. 다시 채택하세요.'
    }
    this.changed()
    return { ok: true, message: msg }
  }

  /** 반영된 항목을 diff에서 고치면 실제 파일에도 바로 쓴다 */
  private async editAppliedMapping(it: Item, m: Mapping, newText: string): Promise<ActionResult> {
    if (!this.fs || !m.file) return { ok: false }
    if (m.moveTo) return { ok: false, message: '문서 이동은 여기서 고칠 수 없습니다.' }
    if (newText === m.newText) return { ok: true }
    const cur = await this.fs.read(m.file)
    if (cur === null) return { ok: false, message: `${m.file}: 파일이 없어 고칠 수 없습니다.` }
    const rec = this.records.get(it.id)
    const r = editApplied(cur, m.newText, newText, rec, m.file)
    if (!r.ok) return { ok: false, message: r.error }
    await this.fs.write(m.file, r.value)
    m.newText = newText
    await this.revalidate()
    return { ok: true }
  }

  /** 새 문서 매핑의 위치(경로)만 바꾼다 */
  async setNewFilePath(itemId: string, mappingId: string, path: string): Promise<ActionResult> {
    const it = this.item(itemId)
    const m = it?.mappings.find((x) => x.id === mappingId)
    if (!it || !m || !this.fs) return { ok: false }
    if (m.oldText !== '' || m.moveTo) return { ok: false, message: '새 문서 매핑만 위치를 바꿀 수 있습니다.' }
    if (!EDITABLE.includes(it.status)) return { ok: false, message: '반영했거나 기존 유지로 결정한 항목은 위치를 바꿀 수 없습니다.' }
    const p = path.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!p || p.endsWith('/')) return { ok: false, message: '파일 이름까지 포함한 경로를 입력하세요.' }
    if (await this.fs.exists(p)) return { ok: false, message: '같은 경로에 이미 파일이 있습니다.' }
    const old = m.file
    m.file = p
    // 같은 항목 안의 목차 링크 매핑이 옛 경로를 가리키면 함께 고친다
    if (old) {
      for (const x of it.mappings) {
        if (x === m || !x.newText || !x.file) continue
        const fromOld = path_posix.relative(path_posix.dirname(x.file), old)
        const toNew = path_posix.relative(path_posix.dirname(x.file), p)
        if (fromOld && x.newText.includes(`(${fromOld})`)) x.newText = x.newText.split(`(${fromOld})`).join(`(${toNew})`)
      }
    }
    let msg = `새 문서 위치를 ${p}(으)로 바꿨습니다.`
    if (it.status === 'approved') {
      it.status = 'pending'
      msg += ' 이 파일의 채택이 풀렸습니다.'
    }
    if (!inScope(p, this.scope)) msg += ' (반영 범위 밖 경로라 반영할 수 없습니다)'
    await this.revalidate()
    return { ok: true, message: msg }
  }

  async setMappingFile(itemId: string, mappingId: string, file: string | null): Promise<ActionResult> {
    const it = this.item(itemId)
    const m = it?.mappings.find((x) => x.id === mappingId)
    if (!it || !m) return { ok: false }
    m.file = file
    this.changed()
    if (!file) return { ok: true }
    if (this.testMode && it.kind === 'content' && this.fs) {
      // 테스트 모드: 이 파일 하나만 예시 변경안으로 채운다 (다른 파일의 변경안은 그대로 둔다)
      const exists = await this.fs.exists(file)
      const text = it.evidence[0]?.quote ?? it.detail
      m.relation = '신규'
      m.oldText = ''
      m.newText = `${exists ? '\n' : ''}## ${m.section || it.title}\n${text}\n`
      m.reason = exists ? '지정한 문서 끝에 예시 문단을 추가합니다.' : '지정한 경로에 예시 문서를 새로 만듭니다.'
      m.approvedSig = undefined
      if (it.status === 'approved') it.status = 'pending'
      await this.revalidate()
      return { ok: true, message: `${file} 기준으로 예시 변경안을 만들었습니다. 이 파일도 검토해 주세요.` }
    }
    return this.regenerate(itemId, `이 항목의 대상 문서를 ${file}로 지정했습니다. 이 파일(없으면 새로 생성)을 기준으로 변경안을 만드세요.`)
  }

  async applyItems(ids: string[]): Promise<ActionResult> {
    if (!this.fs) return { ok: false, message: '프로젝트를 먼저 여세요.' }
    let done = 0
    const fails: string[] = []
    for (const id of ids) {
      const it = this.item(id)
      if (!it || it.status !== 'approved') continue
      if (it.kind === 'content') {
        const outside = it.mappings.filter((m) => isActiveChange(m) && !inScope(m.file as string, this.scope))
        if (outside.length) {
          it.status = 'rereview'
          it.rereviewReason = `반영 범위 밖 파일입니다: ${outside.map((m) => m.file).join(', ')}`
          fails.push(`#${it.no}`)
          continue
        }
      }
      const r = await applyItem(it, this.fs, ++this.order)
      if (!r.ok) {
        it.status = 'rereview'
        it.rereviewReason = r.error
        fails.push(`#${it.no}`)
        await this.revalidate(false)
        continue
      }
      this.records.set(it.id, r.value)
      for (const o of r.value.ops) if (o.before === null && o.after !== null && !o.moved) this.createdPaths.add(o.path)
      it.status = 'applied'
      it.appliedOrder = r.value.order
      it.rereviewReason = undefined
      if (it.kind === 'move') this.renameRefs(it, 'forward')
      done++
      await this.revalidate(false)
    }
    this.changed()
    const rr = this.items.filter((i) => i.status === 'rereview').length
    if (!done && !fails.length) return { ok: false, message: '반영 대기 항목이 없습니다.' }
    let msg = `${done}개 항목을 파일에 반영했습니다`
    if (fails.length) msg += ` · 실패 ${fails.join(', ')} (재검토 필요로 전환)`
    else if (rr) msg += ` · 재검토 필요 ${rr}건`
    return { ok: fails.length === 0, message: msg }
  }

  async applyAllApproved(): Promise<ActionResult> {
    const ids = [...this.items].sort((a, b) => a.no - b.no).filter((i) => i.status === 'approved').map((i) => i.id)
    return this.applyItems(ids)
  }

  /** 이동 반영 후 다른 항목의 매핑 경로 갱신 */
  private renameRefs(it: Item, dir: 'forward' | 'backward'): void {
    const pairs = it.mappings.filter((m) => m.moveTo).map((m) => (dir === 'forward' ? [m.file, m.moveTo] : [m.moveTo, m.file]) as [string, string])
    for (const other of this.items) {
      if (other === it) continue
      for (const m of other.mappings) {
        const p = pairs.find(([a]) => a === m.file)
        if (p) m.file = p[1]
      }
    }
  }

  private async undo(it: Item): Promise<ActionResult> {
    if (!this.fs) return { ok: false }
    const rec = this.records.get(it.id)
    if (!rec) return { ok: false, message: '되돌리기 정보가 없습니다.' }
    const others = [...this.records.values()].filter((r) => r !== rec)
    const r = await undoItem(rec, this.fs, others, this.createdPaths)
    if (!r.ok) {
      if (r.error.startsWith('blocker:')) {
        const b = this.item(r.error.slice(8))
        return { ok: false, message: `같은 구간을 나중에 수정한 #${b?.no ?? '?'} 항목을 먼저 되돌려야 합니다.` }
      }
      return { ok: false, message: r.error }
    }
    this.records.delete(it.id)
    it.status = 'approved'
    it.appliedOrder = undefined
    if (it.kind === 'move') this.renameRefs(it, 'backward')
    await this.revalidate()
    return { ok: true, message: `#${it.no} 반영을 되돌렸습니다. 반영 대기 상태로 돌아갑니다.` }
  }

  async previews(itemId: string): Promise<MappingPreview[]> {
    const it = this.item(itemId)
    if (!it || !this.fs) return []
    const rec = this.records.get(it.id)
    const out: MappingPreview[] = []
    for (const m of it.mappings) {
      const label = m.moveTo ? `${m.file} → ${m.moveTo}` : m.file ?? ''
      if (!m.file) {
        out.push({ mappingId: m.id, path: '', original: '', modified: '', valid: true })
        continue
      }
      if (it.status === 'applied' && (m.rejected || m.held)) {
        // 기존 유지·보류해서 반영하지 않은 파일: 현재 파일만 보여준다
        const now = (await this.fs.read(m.file)) ?? ''
        out.push({ mappingId: m.id, path: label, original: now, modified: now, valid: true })
        continue
      }
      if (it.status === 'applied' && !m.moveTo && isChange(m)) {
        // 반영된 항목: 현재 파일 기준으로 보여주고, 이 항목이 쓴 구간을 바로 고칠 수 있게 한다
        const now = await this.fs.read(m.file)
        if (now !== null && m.newText && countOccurrences(now, m.newText) === 1) {
          const without = m.oldText === '' ? removeAppended(now, m.newText) : now.replace(m.newText, () => m.oldText)
          if (without !== null) {
            out.push({ mappingId: m.id, path: label, original: without, modified: now, valid: true, appliedEdit: true })
            continue
          }
        }
      }
      if (it.status === 'applied' && rec) {
        const src = rec.ops.find((o) => o.path === m.file)
        const dst = m.moveTo ? rec.ops.find((o) => o.path === m.moveTo) : src
        out.push({ mappingId: m.id, path: label, original: src?.before ?? '', modified: dst?.after ?? '', valid: true })
        continue
      }
      const cur = await this.fs.read(m.moveTo && it.status === 'applied' ? m.moveTo : m.file)
      if (!isChange(m)) {
        out.push({ mappingId: m.id, path: label, original: cur ?? '', modified: cur ?? '', valid: true })
        continue
      }
      if (m.moveTo) {
        const p = checkMapping(m, cur, await this.fs.exists(m.moveTo))
        out.push({ mappingId: m.id, path: label, original: cur ?? '', modified: m.newText, valid: !p, problem: p ? describeProblem(p, m.file) : undefined })
        continue
      }
      const r = applyText(cur, m)
      out.push({ mappingId: m.id, path: label, original: cur ?? '', modified: r.ok ? r.value : cur ?? '', valid: r.ok, problem: r.ok ? undefined : r.error })
    }
    return out
  }

  quitSummary(): { unapplied: number; applied: number } {
    return {
      unapplied: this.items.filter((i) => ['pending', 'approved', 'rereview'].includes(i.status)).length,
      applied: this.items.filter((i) => i.status === 'applied').length
    }
  }

  notify(msg: string): void {
    this.toast(msg)
  }
}
