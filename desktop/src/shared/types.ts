// main ↔ renderer가 함께 쓰는 타입. 이 파일에는 Node/DOM 의존성을 두지 않는다.

export type ItemStatus =
  | 'pending' // 검토 대기
  | 'rereview' // 재검토 필요
  | 'approved' // 승인됨 (아직 파일에 저장 안 됨)
  | 'applied' // 반영 완료 (파일에 저장됨)
  | 'confirmed' // 중복 항목 — 기존 반영 확인 완료
  | 'rejected' // 거절됨
  | 'held' // 보류
  | 'excluded' // 미확정 — 기본 반영 제외

export type Relation = '신규' | '중복' | '보완' | '충돌' | '판단 필요' | '이동' | '링크 수정'

export const RELATIONS: Relation[] = ['신규', '중복', '보완', '충돌', '판단 필요']

/** 입력 자료 (텍스트 또는 Markdown/텍스트 파일) */
export interface SourceDoc {
  id: string
  name: string
  text: string
}

/** 원문 근거: 입력 자료의 [start, end) 구간 */
export interface Evidence {
  sourceId: string
  start: number
  end: number
  quote: string
}

/**
 * 항목 ↔ 파일 매핑. 변경은 "oldText를 newText로 바꾼다"는 단일 치환으로 표현한다.
 * - oldText === '' 이면: 파일이 없으면 새로 만들고, 있으면 끝에 덧붙인다.
 * - 중복/판단 필요는 변경을 만들지 않는다.
 * - 이동 항목의 moveTo가 있으면 file → moveTo로 경로가 바뀐다 (내용은 newText).
 */
export interface Mapping {
  id: string
  file: string | null
  section: string
  relation: Relation
  reason: string
  existing: string
  oldText: string
  newText: string
  moveTo?: string
  /** 현재 파일 기준으로 oldText를 찾을 수 없거나 여러 곳에 있음 */
  stale?: 'missing' | 'ambiguous' | null
  /** 파일별 결정 · 기존 유지: 이 파일 변경은 반영하지 않는다 */
  rejected?: boolean
  /** 파일별 결정 · 보류: 지금은 반영하지 않고 나중에 다시 본다 */
  held?: boolean
  /** 파일별 결정 · 제안 채택: 채택할 때의 변경 내용 서명. 내용이 바뀌면 채택이 자동으로 풀린다 */
  approvedSig?: string
}

export interface Item {
  id: string
  no: number
  kind: 'content' | 'move'
  title: string
  detail: string
  confirmed: boolean
  status: ItemStatus
  evidence: Evidence[]
  mappings: Mapping[]
  conflictNote?: string
  /** 재검토 사유 */
  rereviewReason?: string
  /** 반영 순서 (반영된 항목만) */
  appliedOrder?: number
  /** 자동 수정 대상이 아닌 참조 (본문 경로 표현 등) */
  notes?: string[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'ai'
  text: string
  attachments?: { sourceId: string; name: string }[]
  error?: boolean
  /** 오류 원문 (AI 제공자 응답) */
  detail?: string
  /** API 호출 없이 생성한 예시 응답 */
  mock?: boolean
}

export type Provider = 'Anthropic' | 'OpenAI' | 'Gemini' | 'Groq' | 'OpenRouter'

export interface KeyInfo {
  provider: Provider
  tail: string
  model: string
  models: string[]
}

export interface PublicState {
  root: string | null
  rootName: string
  scope: string[]
  sources: SourceDoc[]
  items: Item[]
  messages: ChatMessage[]
  processing: boolean
  processingLabel: string
  key: KeyInfo | null
  /** 이 PC에 저장된 제공자별 키 (끝 4자리만) */
  savedKeys: { provider: Provider; tail: string }[]
  /** OS 보안 저장소로 키를 암호화 저장할 수 있는지 */
  keyPersist: boolean
  testMode: boolean
}

export interface TreeNode {
  path: string // 프로젝트 루트 기준 posix 경로
  name: string
  dir: boolean
  children?: TreeNode[]
}

export interface ActionResult {
  ok: boolean
  message?: string
  /** 저장 충돌: 연 뒤에 다른 곳에서 파일이 바뀌었음 */
  conflict?: boolean
}

export interface MappingPreview {
  mappingId: string
  path: string
  original: string
  modified: string
  valid: boolean
  problem?: string
  /** 반영된 항목: modified가 현재 파일이며, 이 항목이 쓴 구간(newText)을 고치면 파일에 바로 저장된다 */
  appliedEdit?: boolean
}

export interface DocSyncApi {
  openProject(): Promise<PublicState>
  openDemoProject(): Promise<PublicState>
  getState(): Promise<PublicState>
  setTestMode(enabled: boolean): Promise<ActionResult>
  onState(cb: (s: PublicState) => void): () => void
  onFsChanged(cb: () => void): () => void
  onToast(cb: (msg: string) => void): () => void

  tree(): Promise<TreeNode[]>
  readFile(path: string): Promise<string | null>
  /** base: 편집을 시작할 때의 내용. 지금 파일이 base와 다르면 저장하지 않고 conflict를 돌려준다 (null이면 강제 저장) */
  writeFile(path: string, content: string, base?: string | null): Promise<ActionResult>
  createEntry(path: string, dir: boolean): Promise<ActionResult>
  deleteEntry(path: string): Promise<ActionResult>
  toggleScope(path: string): Promise<ActionResult>

  setKey(provider: Provider, key: string): Promise<ActionResult>
  setModel(model: string): Promise<ActionResult>
  clearKey(): Promise<ActionResult>
  useSavedKey(provider: Provider): Promise<ActionResult>

  pickAttachments(): Promise<{ name: string; text: string }[]>
  send(input: { text: string; attachments: { name: string; text: string }[]; selectedItemId: string | null }): Promise<ActionResult>
  stop(): Promise<ActionResult>
  clearConversation(): Promise<ActionResult>

  itemAction(
    id: string,
    action: 'approve' | 'reject' | 'unapprove' | 'restore' | 'include' | 'hold' | 'confirmDup' | 'keep' | 'adopt' | 'undo'
  ): Promise<ActionResult>
  /** 매핑된 파일 하나의 결정: 제안 채택 · 기존 유지 · 보류 · 결정 취소 */
  fileAction(itemId: string, mappingId: string, action: 'adopt' | 'keep' | 'hold' | 'reset'): Promise<ActionResult>
  applyItems(ids: string[]): Promise<ActionResult>
  applyAllApproved(): Promise<ActionResult>
  regenerate(id: string, instruction?: string): Promise<ActionResult>
  editMapping(itemId: string, mappingId: string, newText: string): Promise<ActionResult>
  setMappingFile(itemId: string, mappingId: string, path: string | null): Promise<ActionResult>
  setNewFilePath(itemId: string, mappingId: string, path: string): Promise<ActionResult>
  proposeMove(from: string, to: string): Promise<ActionResult>
  previews(itemId: string): Promise<MappingPreview[]>
}
