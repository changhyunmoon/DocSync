// 프롬프트와 응답 스키마
import { z } from 'zod'
import { callJson, type AiConfig } from './client'
import { callAgent, type AgentTool } from './agent'

const RelationEnum = z.enum(['신규', '중복', '보완', '충돌', '판단 필요'])

export const MappingOut = z.object({
  file: z.string().nullable().describe('대상 파일 경로 (프로젝트 루트 기준). 대상이 없으면 null'),
  section: z.string().describe('대상 섹션 제목 또는 위치 설명'),
  relation: RelationEnum,
  reason: z.string().describe('분류 이유 (한 문장)'),
  existing: z.string().describe('중복·충돌·보완일 때 관련 기존 문구. 없으면 빈 문자열'),
  oldText: z.string().describe('파일에서 그대로 복사한, 파일 안에서 유일한 기준 문구. 새 파일이면 빈 문자열'),
  newText: z.string().describe('oldText를 대체할 내용')
})

export const ItemOut = z.object({
  title: z.string(),
  detail: z.string(),
  confirmed: z.boolean().describe('결정된 내용이면 true, 검토 예정·의견·미정이면 false'),
  evidence: z.array(z.object({ sourceId: z.string(), quote: z.string().describe('입력 자료에서 그대로 복사한 핵심 한두 문장 (200자 이내)') })),
  merge: z.object({
    type: z.enum(['new', 'same', 'refine', 'conflict']),
    itemNo: z.number().int().nullable(),
    note: z.string()
  }),
  mappings: z.array(MappingOut)
})

export const AnalyzeOut = z.object({
  summary: z.string().describe('사용자에게 보여줄 2~4줄 요약'),
  items: z.array(ItemOut)
})

export const RouterOut = z.object({
  intent: z.enum(['analyze', 'move', 'refine', 'reply']),
  reply: z.string().describe('사용자에게 보여줄 짧은 답변'),
  moves: z.array(z.object({ from: z.string(), to: z.string() })).describe('move일 때 파일 단위 이동 목록 (폴더는 파일로 풀어서)'),
  itemNo: z.number().int().nullable().describe('refine 대상 항목 번호'),
  instruction: z.string().describe('refine일 때 변경안에 반영할 지시')
})

export const RefineOut = z.object({
  title: z.string(),
  detail: z.string(),
  mappings: z.array(MappingOut)
})

export type AnalyzeResult = z.infer<typeof AnalyzeOut>
export type RouterResult = z.infer<typeof RouterOut>
export type RefineResult = z.infer<typeof RefineOut>

/** 모든 호출에 공통으로 붙는 작성 언어 규칙 */
export const LANGUAGE_RULE = `작성 언어 (가장 우선)
- 사용자에게 보이는 모든 글(title, detail, summary, reason, note, reply)과 문서에 쓰는 내용(newText)은 반드시 한국어로 씁니다.
- 입력 자료나 기존 문서가 영어여도 새로 쓰는 문장과 제목은 한국어로 씁니다. 기존 문서의 영어 문장을 고칠 필요가 없다면 그대로 둡니다.
- 코드, 명령어, 파일 경로, 클래스·함수·변수 이름, 설정 키, 제품·라이브러리 이름 같은 고유 표기는 번역하지 않고 원래 표기 그대로 씁니다.
- 파일 이름은 한국어로 바꾸지 않고 주변 파일 이름 규칙을 따릅니다.`

const CHANGE_RULES = `변경안 작성 규칙
- 변경은 "oldText를 newText로 치환"하는 방식입니다.
- oldText는 대상 파일의 현재 내용에서 한 글자도 바꾸지 않고 복사한 연속 구간이며, 파일 안에서 딱 한 번만 나와야 합니다. 보통 수정할 줄 전체, 또는 내용을 추가할 위치 바로 앞 줄 전체를 씁니다.
- 내용을 추가할 때는 newText = oldText + 줄바꿈 + 추가 내용처럼 기준 문구를 그대로 포함합니다.
- 새 파일을 만들 때만 oldText를 빈 문자열로 두고 newText에 파일 전체 내용을 씁니다.
- 항목들은 어떤 순서로 반영해도 되도록 서로 독립적이어야 합니다. 다른 항목이 새로 쓰는 내용을 oldText로 쓰지 않습니다. 아직 없는 문서(다른 항목이 만드는 문서)에 내용을 넣을 때는 oldText를 빈 문자열로 두어 끝에 덧붙입니다.
- 중복·판단 필요는 변경을 만들지 않습니다(oldText, newText 모두 빈 문자열). 중복이면 existing에 기존 문구를 씁니다.
- 기존 문서의 문체·형식(제목 수준, 목록, 표)을 따릅니다.
- 파일 경로는 제공된 경로를 그대로 쓰고, "반영 범위" 밖 파일은 수정하지 않습니다.
- 관계 분류: 신규(관련 내용 없음), 중복(같은 의미가 이미 있음), 보완(조건·세부사항 추가), 충돌(기존 내용과 양립 불가), 판단 필요(정보 부족 또는 대상 없음).

문서 구성 원칙: 한 파일에는 한 주제만 (중요)
- 각 문서는 하나의 주제(기능 하나, 정책 하나, 모듈 하나, 절차 하나)만 다룹니다.
- 기존 문서에는 그 문서의 주제와 같은 내용일 때만 추가합니다. 주제가 다르면 관련 단어가 조금 겹치더라도 넣지 않고, 그 주제의 문서를 찾거나 새로 만듭니다.
- 입력 자료에 여러 주제가 섞여 있으면 주제마다 항목과 파일을 나눕니다. 한 newText에 여러 주제를 몰아 쓰지 않습니다.
- README.md·index.md 같은 목차 문서에는 본문을 쓰지 않고, 각 주제 문서로 가는 링크와 한 줄 설명만 추가합니다.
- 서로 다른 항목이 같은 새 문서를 만들지 않습니다. 같은 주제라면 한 항목으로 합치고, 다른 주제라면 파일을 나눕니다.

새 문서 규칙
- 먼저 같은 주제의 기존 문서가 있는지 찾고, 없을 때만 새 문서를 만듭니다.
- 새 문서의 위치는 [프로젝트 폴더 구조]의 기존 분류를 따라 가장 알맞은 반영 범위 안 폴더로 정합니다. 맞는 폴더가 없을 때만 새 폴더를 만듭니다.
- 파일 이름은 주제를 드러내게 짓고(예: login-lockout.md, session-expiry.md), 주변 파일의 이름 규칙(언어, 대소문자, 구분자 - 또는 _, 확장자)을 그대로 따릅니다.
- 새 문서는 "# 주제 제목"으로 시작하고 그 주제의 내용만 담습니다.
- 새 문서 매핑은 section을 "새 문서"로, reason에 "왜 이 위치·이름인지"를 씁니다.
- 문서 목록·목차 역할을 하는 기존 문서(README.md, index.md 등)가 있으면, 새 문서로 가는 상대 링크를 추가하는 매핑도 같은 항목에 넣습니다.
- docs_map.md는 앱이 관리하는 문서 지도이므로 변경 대상·목차 문서로 쓰지 않습니다.`

const ANALYZE_SYSTEM = `${LANGUAGE_RULE}

당신은 기획안·회의록·긴 글에서 개발 가이드에 반영할 내용을 추출하고, 프로젝트의 Markdown 문서 변경안을 만드는 도우미입니다.

항목 추출 규칙
- 입력 자료를 독립적으로 검토·반영할 수 있는 요구사항·결정·정책 단위로 나눕니다. 항목 하나는 주제 하나만 다룹니다. 참석자·일정·잡담은 항목으로 만들지 않습니다.
- evidence.quote는 입력 자료에서 그대로 복사한 연속 구간입니다(요약·수정 금지). 근거가 되는 핵심 한두 문장만, 200자 이내로 씁니다. 표·코드 블록 전체를 복사하지 않습니다. sourceId는 자료의 id입니다.
- 결정되지 않은 내용(검토 예정, 의견, 미정)은 confirmed=false로 표시합니다.
- 문서에 이미 같은 의미로 들어 있는 내용도 빠뜨리지 말고 항목으로 추출합니다. 이때 그 문서 매핑은 relation=중복, existing에는 문서의 해당 문구를 한 글자도 바꾸지 않고 복사하며(1~3줄), oldText·newText는 빈 문자열입니다. 사용자는 이것으로 "이미 존재"를 확인합니다.
- 문서에 일부만 있고 빠진 조건·수치가 있으면 중복이 아니라 보완으로 분류해 빠진 부분만 추가합니다.
- 하나의 항목을 여러 파일에 매핑할 수 있으며, 관계 분류는 파일마다 따로 정합니다. 적절한 대상이 없으면 file=null, relation=판단 필요로 두고 reason에 기존 파일 지정이나 새 문서 생성을 제안합니다.

${CHANGE_RULES}

기존 항목과 병합 규칙 (기존 항목이 주어진 경우)
- new: 새로운 요구사항 (itemNo=null)
- same: 기존 항목과 같은 내용 → itemNo에 기존 번호, mappings는 빈 배열
- refine: 기존 항목을 구체화 → itemNo, 갱신된 title·detail·mappings 전체
- conflict: 기존 항목과 충돌 → itemNo, note에 충돌 내용, mappings에는 새 자료 기준 변경안
- 이미 반영된 항목이 영향을 받으면 현재 파일 내용을 기준으로 변경안을 만듭니다.
기존 항목이 없으면 모두 new입니다.`

export interface DocContext {
  tree?: string
  /** 문서 지도 (있으면 내용을 넣지 않은 문서는 지도 설명으로 대신한다) */
  map?: string
  scope: string[]
  files: { path: string; content: string | null }[] // content=null이면 목록만
  outOfScope: string[]
}

function renderDocs(ctx: DocContext): string {
  const lines: string[] = []
  lines.push(`[반영 범위] ${ctx.scope.length ? ctx.scope.join(', ') : '(프로젝트 전체)'}`)
  lines.push('')
  if (ctx.tree) {
    lines.push('[프로젝트 폴더 구조]')
    lines.push(ctx.tree)
    lines.push('')
  }
  if (ctx.map) {
    lines.push('[문서 지도 docs_map — 반영 범위 모든 문서의 성격·내용 요약]')
    lines.push(ctx.map)
    lines.push('')
    lines.push('[관련 문서 본문 — 지도에서 이 항목들과 관련 있다고 고른 문서만 넣었습니다. 본문이 없는 문서는 수정 대상으로 삼지 말고, 필요하면 판단 필요로 남깁니다]')
  } else lines.push('[반영 범위 문서]')
  for (const f of ctx.files) {
    if (f.content == null) {
      if (!ctx.map) lines.push(`=== ${f.path} === (내용 생략: 크기 제한)`)
      continue
    }
    lines.push(`=== ${f.path} ===\n${f.content}\n=== 끝: ${f.path} ===`)
  }
  if (ctx.outOfScope.length) {
    lines.push('')
    lines.push('[범위 밖 파일 — 참고용, 수정 금지]')
    lines.push(ctx.outOfScope.slice(0, 300).join('\n'))
  }
  return lines.join('\n')
}

export interface ExistingItemBrief {
  no: number
  title: string
  detail: string
  status: string
  confirmed: boolean
  mappings: { file: string | null; relation: string }[]
}

export async function analyze(
  cfg: AiConfig,
  input: {
    request: string
    sources: { id: string; name: string; text: string }[]
    existing: ExistingItemBrief[]
    docs: DocContext
  },
  signal?: AbortSignal
): Promise<AnalyzeResult> {
  const parts: string[] = []
  parts.push(`[사용자 요청]\n${input.request || '자료에서 개발 가이드에 반영할 항목을 추출하고 변경안을 만들어주세요.'}`)
  parts.push('[입력 자료]')
  for (const s of input.sources) parts.push(`--- 자료 id=${s.id} 이름=${s.name} ---\n${s.text}\n--- 자료 끝 ---`)
  parts.push(`[기존 항목]\n${input.existing.length ? JSON.stringify(input.existing, null, 1) : '(없음)'}`)
  parts.push(renderDocs(input.docs))
  return callJson(cfg, 'submit_items', AnalyzeOut, ANALYZE_SYSTEM, parts.join('\n\n'), signal)
}

const ROUTER_SYSTEM = `${LANGUAGE_RULE}

당신은 문서 반영 앱의 대화 처리기입니다. 사용자의 메시지를 보고 의도를 하나로 분류합니다.
- analyze: 새 요구사항·결정·자료 내용을 문서에 반영해 달라는 요청
- move: 파일·폴더를 옮기거나 이름을 바꿔 달라는 요청 → moves에 파일 단위 [from, to] 목록 (폴더는 안의 파일로 풀어서, 경로는 제공된 파일 목록 기준)
- refine: 특정 항목(선택된 항목 또는 번호로 지목한 항목)의 변경안을 고쳐 달라는 요청 → itemNo, instruction
- reply: 질문이거나 위에 해당하지 않음 → reply에 짧게 답변
reply 필드에는 항상 사용자에게 보여줄 한두 문장을 씁니다.`

export async function route(
  cfg: AiConfig,
  input: { message: string; files: string[]; items: ExistingItemBrief[]; selectedNo: number | null },
  signal?: AbortSignal
): Promise<RouterResult> {
  const user = [
    `[사용자 메시지]\n${input.message}`,
    `[선택된 항목] ${input.selectedNo ?? '없음'}`,
    `[항목 목록]\n${input.items.length ? JSON.stringify(input.items.map((i) => ({ no: i.no, title: i.title, status: i.status }))) : '(없음)'}`,
    `[프로젝트 파일]\n${input.files.slice(0, 1500).join('\n')}`
  ].join('\n\n')
  return callJson(cfg, 'route', RouterOut, ROUTER_SYSTEM, user, signal)
}

const REFINE_SYSTEM = `${LANGUAGE_RULE}

당신은 문서 반영 앱에서 하나의 항목에 대한 변경안을 다시 만드는 도우미입니다.
항목의 원문 근거와 지시를 바탕으로, 현재 파일 내용을 기준으로 title·detail·mappings 전체를 다시 작성합니다.
관계 분류는 파일마다 정합니다. 적절한 대상이 없으면 file=null, relation=판단 필요.

${CHANGE_RULES}`

export async function refine(
  cfg: AiConfig,
  input: {
    item: { no: number; title: string; detail: string; evidence: string[]; mappings: unknown[] }
    instruction: string
    docs: DocContext
  },
  signal?: AbortSignal
): Promise<RefineResult> {
  const user = [
    `[지시]\n${input.instruction}`,
    `[항목 #${input.item.no}]\n제목: ${input.item.title}\n내용: ${input.item.detail}\n원문 근거:\n${input.item.evidence.map((e) => '- ' + e).join('\n')}`,
    `[현재 변경안]\n${JSON.stringify(input.item.mappings, null, 1)}`,
    renderDocs(input.docs)
  ].join('\n\n')
  return callJson(cfg, 'submit_item', RefineOut, REFINE_SYSTEM, user, signal)
}


// ───────── 프로젝트 탐색형 (도구 사용) ─────────

export interface AgentContext {
  tree: string
  /** 문서 지도 (압축 형태) */
  map?: string
  scope: string[]
  tools: AgentTool[]
  onStep?: (label: string) => void
}

const AGENT_INTRO = `[프로젝트 연결]
이 프로젝트는 도구로 직접 탐색할 수 있습니다: list_dir(폴더 목록), read_file(파일 읽기), search(문서 검색).
문서 내용은 미리 넣어 두지 않았으니, 관련 있어 보이는 문서를 찾아 읽은 뒤 판단하세요.`

function agentDocs(ctx: AgentContext): string {
  return [
    AGENT_INTRO,
    `[반영 범위] ${ctx.scope.length ? ctx.scope.join(', ') : '(프로젝트 전체)'} — 이 범위 밖 파일은 읽기만 하고 수정하지 않습니다.`,
    `[프로젝트 폴더 구조]\n${ctx.tree}`,
    ...(ctx.map
      ? [`[문서 지도 docs_map — 반영 범위 문서마다 성격·내용 요약]\n${ctx.map}\n\n지도를 보고 이 작업과 관련 있는 문서만 read_file로 읽으세요. 관련 없어 보이는 문서는 열지 않습니다. 단, 수정하거나 중복·충돌을 판단할 문서는 반드시 본문을 읽고 판단합니다.`]
      : [])
  ].join('\n\n')
}

export async function analyzeAgent(
  cfg: AiConfig,
  input: { request: string; sources: { id: string; name: string; text: string }[]; existing: ExistingItemBrief[] },
  ctx: AgentContext,
  signal?: AbortSignal
): Promise<{ value: AnalyzeResult; read: string[] }> {
  const parts: string[] = []
  parts.push(`[사용자 요청]\n${input.request || '자료에서 개발 가이드에 반영할 항목을 추출하고 변경안을 만들어주세요.'}`)
  parts.push('[입력 자료]')
  for (const s of input.sources) parts.push(`--- 자료 id=${s.id} 이름=${s.name} ---\n${s.text}\n--- 자료 끝 ---`)
  parts.push(`[기존 항목]\n${input.existing.length ? JSON.stringify(input.existing, null, 1) : '(없음)'}`)
  parts.push(agentDocs(ctx))
  return callAgent(cfg, {
    system: ANALYZE_SYSTEM,
    user: parts.join('\n\n'),
    finalName: 'submit_items',
    finalDescription: '추출한 항목과 변경안을 최종 제출합니다.',
    schema: AnalyzeOut,
    tools: ctx.tools,
    onStep: ctx.onStep,
    signal
  })
}

export async function refineAgent(
  cfg: AiConfig,
  input: { item: { no: number; title: string; detail: string; evidence: string[]; mappings: unknown[] }; instruction: string },
  ctx: AgentContext,
  signal?: AbortSignal
): Promise<{ value: RefineResult; read: string[] }> {
  const user = [
    `[지시]\n${input.instruction}`,
    `[항목 #${input.item.no}]\n제목: ${input.item.title}\n내용: ${input.item.detail}\n원문 근거:\n${input.item.evidence.map((e) => '- ' + e).join('\n')}`,
    `[현재 변경안]\n${JSON.stringify(input.item.mappings, null, 1)}`,
    agentDocs(ctx)
  ].join('\n\n')
  return callAgent(cfg, {
    system: REFINE_SYSTEM,
    user,
    finalName: 'submit_item',
    finalDescription: '다시 만든 항목과 변경안을 최종 제출합니다.',
    schema: RefineOut,
    tools: ctx.tools,
    maxSteps: 10,
    onStep: ctx.onStep,
    signal
  })
}


// ───────── 문서 지도 ─────────

export const SummaryOut = z.object({
  docs: z.array(
    z.object({
      path: z.string(),
      kind: z.string().describe('문서 성격 한두 단어 (예: 정책, 가이드, API 명세, 절차, 목차, 회의 기록)'),
      summary: z.string().describe('이 문서가 담고 있는 주제와 핵심 내용 한두 문장 (120자 이내)')
    })
  )
})
export type SummaryResult = z.infer<typeof SummaryOut>

const SUMMARY_SYSTEM = `${LANGUAGE_RULE}

당신은 프로젝트 문서의 "문서 지도"를 만드는 도우미입니다.
각 문서가 어떤 성격의 문서이고 어떤 주제·내용을 담고 있는지 짧게 적습니다.
나중에 회의록·기획안의 항목이 어느 문서와 관련 있는지 이 설명만 보고 고르게 되므로,
문서에만 있는 구체적인 주제어(기능 이름, 정책 이름, 수치, 코드 이름)를 넣어 구별되게 씁니다.
입력된 모든 문서에 대해 path를 그대로 써서 하나씩 답합니다.`

export async function summarizeDocs(
  cfg: AiConfig,
  files: { path: string; content: string }[],
  signal?: AbortSignal
): Promise<SummaryResult> {
  const user = ['[문서]', ...files.map((f) => `=== ${f.path} ===\n${f.content}\n=== 끝: ${f.path} ===`)].join('\n\n')
  return callJson(cfg, 'submit_summaries', SummaryOut, SUMMARY_SYSTEM, user, signal)
}

export const SelectOut = z.object({
  files: z.array(z.string()).describe('관련 문서 경로 (지도에 있는 경로 그대로)'),
  reason: z.string().describe('고른 이유 한 문장')
})

const SELECT_SYSTEM = `${LANGUAGE_RULE}

당신은 문서 반영 앱에서 관련 문서를 고르는 도우미입니다.
입력 자료(회의록·기획안 등)의 내용을 반영할 때 읽어야 하는 문서를 문서 지도에서 고릅니다.
- 내용을 추가·수정할 가능성이 있는 문서, 같은 주제를 이미 다루는 문서(중복·충돌 확인용), 새 문서 링크를 넣을 목차 문서를 고릅니다.
- 관련 없는 문서는 고르지 않습니다. 보통 2~8개, 많아도 15개 이내입니다.
- 관련 문서가 없으면 빈 배열을 돌려줍니다(새 문서를 만들게 됩니다).`

export async function selectDocs(
  cfg: AiConfig,
  input: { request: string; sources: { name: string; text: string }[]; existing: ExistingItemBrief[]; map: string },
  signal?: AbortSignal
): Promise<z.infer<typeof SelectOut>> {
  const user = [
    `[사용자 요청]\n${input.request || '자료 내용을 문서에 반영'}`,
    '[입력 자료]',
    ...input.sources.map((s) => `--- ${s.name} ---\n${s.text}\n--- 끝 ---`),
    `[기존 항목]\n${input.existing.length ? JSON.stringify(input.existing.map((i) => ({ no: i.no, title: i.title, files: i.mappings.map((m) => m.file) }))) : '(없음)'}`,
    `[문서 지도]\n${input.map}`
  ].join('\n\n')
  return callJson(cfg, 'select_docs', SelectOut, SELECT_SYSTEM, user, signal)
}
