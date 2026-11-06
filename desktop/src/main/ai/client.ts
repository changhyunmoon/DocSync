// AI 제공자 호출. 응답은 항상 JSON 스키마로 강제하고 zod로 검증한다.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { Provider } from '@shared/types'

export interface AiConfig {
  provider: Provider
  apiKey: string
  model: string
}

/** OpenAI 호환 API를 쓰는 제공자 */
const COMPAT: Partial<Record<Provider, { baseURL: string; headers?: Record<string, string> }>> = {
  Groq: { baseURL: 'https://api.groq.com/openai/v1' },
  OpenRouter: { baseURL: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'DocSync' } }
}

export const isCompat = (p: Provider): boolean => !!COMPAT[p]

export function openai(provider: Provider, apiKey: string): OpenAI {
  const c = COMPAT[provider]
  // DOCSYNC_COMPAT_BASE_URL: 테스트용 서버 주소 덮어쓰기
  const baseURL = c ? process.env.DOCSYNC_COMPAT_BASE_URL || c.baseURL : undefined
  return new OpenAI({ apiKey, baseURL, defaultHeaders: c?.headers })
}

/** 제공자별로 한 번에 보낼 문서 분량(문자 수). 무료 등급은 분당 토큰 한도가 작다 */
export function contextBudget(provider: Provider): number {
  if (provider === 'Groq') return 20_000
  if (provider === 'OpenRouter') return 60_000
  return 150_000
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

/** 키 확인 겸 사용 가능한 모델 목록 */
export async function listModels(provider: Provider, apiKey: string): Promise<string[]> {
  if (provider === 'Anthropic') {
    const c = new Anthropic({ apiKey })
    const ids: string[] = []
    for await (const m of c.models.list({ limit: 100 })) ids.push(m.id)
    return ids
  }
  if (provider === 'Gemini') {
    const g = new GoogleGenAI({ apiKey })
    const ids: string[] = []
    for await (const m of await g.models.list({ config: { pageSize: 100 } })) {
      const id = (m.name ?? '').replace(/^models\//, '')
      if (!/^gemini-/.test(id)) continue
      if (m.supportedActions && !m.supportedActions.includes('generateContent')) continue
      if (/(embedding|image|tts|audio|live|vision)/.test(id)) continue
      ids.push(id)
    }
    return ids.sort().reverse()
  }
  const c = openai(provider, apiKey)
  const ids: string[] = []
  for await (const m of c.models.list()) ids.push(m.id)
  if (provider === 'Groq') {
    return ids.filter((id) => !/(whisper|tts|guard|playai|orpheus|compound|embed)/i.test(id)).sort()
  }
  if (provider === 'OpenRouter') {
    const usable = ids.filter((id) => !/(embed|image|audio|tts|whisper|moderation|guard)/i.test(id))
    return [...usable.filter((id) => id.endsWith(':free')).sort(), ...usable.filter((id) => !id.endsWith(':free')).sort()]
  }
  return ids
    .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
    .sort()
    .reverse()
}

const ver = (m: string): number => parseFloat(m.match(/(\d+(?:\.\d+)?)/)?.[1] ?? '0')

/** 기본 모델 후보 (앞에서부터 실제 호출로 확인해서 첫 번째로 되는 모델을 쓴다) */
export function modelCandidates(provider: Provider, models: string[]): string[] {
  const out: string[] = []
  const add = (m?: string) => m && models.includes(m) && !out.includes(m) && out.push(m)
  if (provider === 'Gemini') {
    add('gemini-pro-latest')
    add('gemini-flash-latest')
    const stable = models.filter((m) => !/(preview|exp|lite|latest)/.test(m)).sort((a, b) => ver(b) - ver(a))
    stable.filter((m) => /-pro$/.test(m)).forEach(add)
    stable.filter((m) => /-flash$/.test(m)).forEach(add)
    models.forEach(add)
    return out
  }
  add(pickDefaultModel(provider, models))
  if (provider === 'OpenRouter') models.filter((m) => m.endsWith(':free')).forEach(add)
  models.forEach(add)
  return out
}

/** 이 키로 해당 모델을 실제로 쓸 수 있는지 아주 짧은 호출로 확인. 키·한도 문제는 그대로 던진다 */
export async function probeModel(cfg: AiConfig): Promise<boolean> {
  try {
    if (cfg.provider === 'Anthropic') {
      await new Anthropic({ apiKey: cfg.apiKey }).messages.create({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    } else if (cfg.provider === 'Gemini') {
      await new GoogleGenAI({ apiKey: cfg.apiKey }).models.generateContent({ model: cfg.model, contents: 'ping', config: { maxOutputTokens: 16 } })
    } else if (isCompat(cfg.provider)) {
      await openai(cfg.provider, cfg.apiKey).chat.completions.create({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 })
    } else {
      await openai(cfg.provider, cfg.apiKey).chat.completions.create({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 16 })
    }
    return true
  } catch (e) {
    if (isHardQuota(e) || statusOf(e) === 402) return false // 이 요금제로는 쓸 수 없는 모델 → 다음 후보로
    const status = statusOf(e)
    if (status === 401 || status === 429 || (status && status >= 500)) throw e
    return false
  }
}

export function pickDefaultModel(provider: Provider, models: string[]): string {
  if (provider === 'Anthropic') return models.find((m) => m.includes('sonnet')) ?? models[0] ?? ''
  if (provider === 'Gemini') {
    const stable = models.filter((m) => !/(preview|exp|lite)/.test(m))
    return stable.find((m) => /-pro$/.test(m)) ?? stable.find((m) => /-flash$/.test(m)) ?? models[0] ?? ''
  }
  if (provider === 'Groq') {
    return [/gpt-oss-120b/, /llama-3\.3-70b/, /qwen/, /llama-4/, /gpt-oss/].map((r) => models.find((m) => r.test(m))).find(Boolean) ?? models[0] ?? ''
  }
  if (provider === 'OpenRouter') {
    const free = models.filter((m) => m.endsWith(':free'))
    return [/gpt-oss-120b/, /deepseek/, /qwen3/, /llama-3\.3-70b/, /gemini/].map((r) => free.find((m) => r.test(m))).find(Boolean) ?? free[0] ?? models[0] ?? ''
  }
  return models.find((m) => /^gpt-5/.test(m) && !m.includes('nano')) ?? models.find((m) => m.startsWith('gpt-')) ?? models[0] ?? ''
}

export function statusOf(e: unknown): number | undefined {
  const x = e as { status?: number; code?: number }
  return typeof x?.status === 'number' ? x.status : typeof x?.code === 'number' ? x.code : undefined
}

/** 할당량이 0이거나 하루 한도를 다 쓴 429 — 기다려도 곧 풀리지 않으므로 재시도하지 않는다 */
export function isHardQuota(e: unknown): boolean {
  if (statusOf(e) !== 429) return false
  const msg = (e instanceof Error ? e.message : String(e)) + JSON.stringify((e as { error?: unknown })?.error ?? '')
  return /limit:\s*0\b|PerDay|insufficient_quota|retry in \d+h|check your plan and billing/i.test(msg) || isTooLarge(e)
}

/** 요청 자체가 모델·요금제 한도보다 큼 (기다려도 해결되지 않음) */
export function isTooLarge(e: unknown): boolean {
  const st = statusOf(e)
  const msg = (e instanceof Error ? e.message : String(e)) + JSON.stringify((e as { error?: unknown })?.error ?? '')
  return st === 413 || ((st === 429 || st === 400) && /request too large|reduce your message size|context length|maximum context|too many tokens/i.test(msg))
}

/** 출력 토큰 한도에 걸려 JSON을 끝까지 만들지 못함 (Groq json_validate_failed 등) */
export function isOutputCut(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)) + JSON.stringify((e as { error?: unknown })?.error ?? '')
  return statusOf(e) === 400 && /json_validate_failed|max completion tokens|Failed to generate JSON/i.test(msg)
}

/** 코드 블록·추론 태그를 걷어내고 JSON 객체만 꺼낸다 */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no json')
  return JSON.parse(t.slice(a, b + 1))
}

/** OpenAI 호환 제공자의 모델별 구조화 출력 방식 (json_schema → json_object → 프롬프트만) */
const compatMode = new Map<string, number>()
const COMPAT_MODES = ['json_schema', 'json_object', 'text'] as const

function formatUnsupported(e: unknown): boolean {
  const st = statusOf(e)
  const msg = (e instanceof Error ? e.message : String(e)) + JSON.stringify((e as { error?: unknown })?.error ?? '')
  return (st === 400 || st === 404 || st === 422) && /response_format|json_schema|json_object|structured|not support|unsupported|json mode|tool/i.test(msg)
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })

/** 일시적인 서버 오류(429·5xx)는 잠시 기다렸다가 두 번까지 다시 시도한다 */
export async function retryTransient<T>(fn: () => Promise<T>, signal?: AbortSignal, onWait?: (sec: number) => void): Promise<T> {
  const waits = [2000, 6000, 20000]
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const st = statusOf(e)
      const transient = (st === 429 && !isHardQuota(e)) || (st !== undefined && st >= 500)
      if (!transient || i >= waits.length || signal?.aborted) throw e
      // 분당 한도(429)는 서버가 알려준 대기 시간(retry-after)을 따른다 (최대 65초)
      const ra = Number((e as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.('retry-after'))
      const wait = st === 429 && ra > 0 && ra <= 65 ? Math.ceil(ra * 1000) + 500 : waits[i]
      console.warn(`[DocSync] AI 일시 오류 ${st}, ${Math.round(wait / 1000)}초 후 다시 시도 (${i + 1}/${waits.length})`)
      onWait?.(Math.round(wait / 1000))
      await sleep(wait, signal)
    }
  }
}

/** 사용자에게 '자세히'로 보여줄 오류 원문 */
export function errorDetail(e: unknown): string {
  const st = statusOf(e)
  let msg = e instanceof Error ? e.message : String(e)
  const body = (e as { error?: unknown })?.error
  if (body && typeof body === 'object') {
    try {
      msg += '\n' + JSON.stringify(body, null, 1)
    } catch {
      /* ignore */
    }
  }
  const text = `${st ? `HTTP ${st} · ` : ''}${msg}`
  return text.length > 1500 ? text.slice(0, 1500) + '…' : text
}

/**
 * system + user 프롬프트로 호출해서 schema에 맞는 JSON을 받는다.
 * 검증에 실패하면 오류를 알려주고 한 번 더 요청한다.
 */
export async function callJson<T extends z.ZodType>(
  cfg: AiConfig,
  name: string,
  schema: T,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<z.infer<T>> {
  const js = jsonSchemaOf(schema)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = `${user}\n\n[작성 언어] 모든 글과 문서 내용은 한국어로 씁니다 (코드·경로·고유 이름은 원래 표기).`
    const prompt = lastError
      ? `${base}\n\n[이전 응답 오류]\n이전 응답이 스키마 검증에 실패했습니다: ${lastError}\n스키마에 정확히 맞춰 다시 답하세요.`
      : base
    let raw: unknown
    if (cfg.provider === 'Anthropic') {
      const c = new Anthropic({ apiKey: cfg.apiKey })
      const res = await retryTransient(() => c.messages.create(
        {
          model: cfg.model,
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ name, description: '결과를 이 도구의 입력 형식으로 제출합니다.', input_schema: js as Anthropic.Tool.InputSchema }],
          tool_choice: { type: 'tool', name }
        },
        { signal }
      ), signal)
      const block = res.content.find((b) => b.type === 'tool_use')
      if (!block || block.type !== 'tool_use') {
        lastError = '도구 호출이 없습니다.'
        continue
      }
      raw = block.input
    } else if (cfg.provider === 'Gemini') {
      const g = new GoogleGenAI({ apiKey: cfg.apiKey })
      const res = await retryTransient(() => g.models.generateContent({
        model: cfg.model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: js,
          maxOutputTokens: 32000,
          abortSignal: signal
        }
      }), signal)
      try {
        raw = JSON.parse(res.text ?? '')
      } catch {
        lastError = 'JSON 형식이 아닙니다.'
        continue
      }
    } else if (isCompat(cfg.provider)) {
      const c = openai(cfg.provider, cfg.apiKey)
      const key = `${cfg.provider}:${cfg.model}`
      let text = ''
      for (let mode = compatMode.get(key) ?? 0; ; mode++) {
        const kind = COMPAT_MODES[mode]
        const concise = '\n\n분량 제한: 출력 길이가 제한되어 있으니 detail·reason·summary는 한 문장으로 짧게 쓰고, oldText·newText는 바꿀 줄만 포함하세요.'
        const sys = kind === 'json_schema' ? system + concise : `${system}${concise}\n\n응답 형식: 아래 JSON 스키마를 따르는 JSON 객체 하나만 출력하세요. 설명 문장이나 코드 블록 없이 JSON만 씁니다.\n${JSON.stringify(js)}`
        try {
          const res = await retryTransient(() => c.chat.completions.create(
            {
              model: cfg.model,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: prompt }
              ],
              // 무료 등급은 입력+출력 합계로 분당 한도를 세므로 출력 예약을 적당히 잡는다
              max_tokens: cfg.provider === 'Groq' ? 4000 : 8000,
              // gpt-oss 같은 추론 모델은 생각에 토큰을 많이 써서 결과를 다 못 쓰는 경우가 있다
              ...(/gpt-oss/.test(cfg.model) ? { reasoning_effort: 'low' as const } : {}),
              ...(kind === 'json_schema'
                ? { response_format: { type: 'json_schema' as const, json_schema: { name, schema: js, strict: false } } }
                : kind === 'json_object'
                  ? { response_format: { type: 'json_object' as const } }
                  : {})
            },
            { signal }
          ), signal)
          compatMode.set(key, mode)
          text = res.choices[0]?.message?.content ?? ''
          break
        } catch (e) {
          if (mode < COMPAT_MODES.length - 1 && formatUnsupported(e)) {
            console.warn(`[DocSync] ${cfg.model}: ${kind} 미지원 → ${COMPAT_MODES[mode + 1]} 방식으로 다시 시도`)
            continue
          }
          if (mode > 0) compatMode.set(key, mode) // 형식 문제는 아니었으므로 찾은 방식은 기억
          if (isOutputCut(e) && attempt === 0) {
            text = ''
            break
          }
          throw e
        }
      }
      if (!text) {
        lastError = '출력 길이 한도에 걸려 JSON을 끝까지 쓰지 못했습니다. 항목은 그대로 두고 각 문장을 훨씬 짧게 쓰세요.'
        continue
      }
      try {
        raw = extractJson(text)
      } catch {
        lastError = 'JSON 형식이 아닙니다.'
        continue
      }
    } else {
      const c = openai(cfg.provider, cfg.apiKey)
      const res = await retryTransient(() => c.chat.completions.create(
        {
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_schema', json_schema: { name, schema: js, strict: false } }
        },
        { signal }
      ), signal)
      const text = res.choices[0]?.message?.content ?? ''
      try {
        raw = JSON.parse(text)
      } catch {
        lastError = 'JSON 형식이 아닙니다.'
        continue
      }
    }
    const parsed = schema.safeParse(raw)
    if (parsed.success) return parsed.data
    lastError = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
  }
  throw new Error(`AI 응답 형식이 올바르지 않습니다 (${lastError})`)
}

export function describeAiError(e: unknown, model?: string): string {
  if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) return '요청을 중지했습니다.'
  const custom = (e as { userMessage?: string })?.userMessage
  if (custom) return custom
  const status = statusOf(e)
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(String((e as Error)?.message))) return 'API 키가 올바르지 않습니다. 키를 다시 확인하세요.'
  if (status === 401) return 'API 키가 올바르지 않습니다. 키를 다시 확인하세요.'
  if (status === 403) return '이 키로는 해당 모델을 사용할 수 없습니다.'
  if (status === 404) return `모델을 찾을 수 없습니다${model ? ` (${model})` : ''}. 상단 API 키 버튼에서 다른 모델을 선택하세요.`
  if (isOutputCut(e)) return `${model ?? '모델'}이(가) 출력 길이 한도 안에 결과를 다 쓰지 못했습니다. 자료를 더 짧게 나눠 보내거나, 반영 범위를 좁히거나, 다른 모델을 선택하세요.`
  if (isTooLarge(e)) return `요청이 ${model ?? '이 모델'}의 한도보다 큽니다. 반영 범위(◎)를 더 좁히거나, 자료를 나눠 보내거나, 더 큰 모델을 선택하세요.`
  if (status === 402) return '크레딧이 부족합니다. 무료 모델(이름이 :free로 끝나는 모델)을 선택하거나 크레딧을 충전하세요.'
  if (isHardQuota(e)) return `현재 키의 요금제로는 ${model ?? '이'} 모델의 사용 한도가 없거나 오늘 한도를 모두 썼습니다. 상단 API 키 버튼에서 다른 모델(Gemini는 Flash, OpenRouter는 :free 모델)을 선택하세요.`
  if (status === 429) return '요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.'
  if (status && status >= 500) return 'AI 제공자 서버 오류입니다. 잠시 후 다시 시도하세요.'
  return e instanceof Error ? e.message : String(e)
}
