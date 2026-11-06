// 프로젝트 탐색형 호출: AI가 폴더 목록 보기·파일 읽기·검색 도구로 프로젝트를 직접 살펴본 뒤
// 마지막에 결과 제출 도구(스키마)를 호출한다. 데스크톱 Claude의 "프로젝트 연결"과 같은 방식.
import Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { GoogleGenAI, type Content } from '@google/genai'
import { z } from 'zod'
import { extractJson, isCompat, jsonSchemaOf, openai, retryTransient, statusOf, type AiConfig } from './client'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema (object)
  run(args: Record<string, unknown>): Promise<string>
  /** 진행 표시 문구 */
  label(args: Record<string, unknown>): string
}

export interface AgentOptions<T extends z.ZodType> {
  system: string
  user: string
  finalName: string
  finalDescription: string
  schema: T
  tools: AgentTool[]
  maxSteps?: number
  onStep?: (label: string) => void
  signal?: AbortSignal
}

/** 도구 호출(function calling)을 지원하지 않는 모델 → 기존 방식으로 대체 */
export class ToolsUnsupported extends Error {}

function toolsUnsupported(e: unknown): boolean {
  const st = statusOf(e)
  const msg = (e instanceof Error ? e.message : String(e)) + JSON.stringify((e as { error?: unknown })?.error ?? '')
  return (st === 400 || st === 404 || st === 422) && /tool|function/i.test(msg) && /support|not available|no endpoints|unsupported|invalid/i.test(msg)
}

const FINAL_NOTE = (name: string) =>
  `\n\n작업 방법\n- 필요한 폴더와 문서는 도구로 직접 살펴보고 읽은 뒤 판단합니다. 추측으로 경로나 내용을 지어내지 않습니다.\n- oldText는 반드시 read_file로 읽은 실제 내용에서 그대로 복사합니다.\n- 같은 파일을 여러 번 읽지 않도록 필요한 범위만 읽습니다.\n- 모든 확인이 끝나면 ${name} 도구를 한 번 호출해 결과를 제출합니다. 다른 방식으로 답하지 않습니다.\n- 제출하는 모든 글과 문서 내용(newText)은 한국어로 씁니다. 코드·경로·고유 이름은 원래 표기를 유지합니다.`

function validate<T extends z.ZodType>(schema: T, raw: unknown): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
}

export async function callAgent<T extends z.ZodType>(cfg: AiConfig, o: AgentOptions<T>): Promise<{ value: z.infer<T>; read: string[] }> {
  const maxSteps = o.maxSteps ?? 14
  const read = new Set<string>()
  const finalSchema = jsonSchemaOf(o.schema)
  const system = o.system + FINAL_NOTE(o.finalName)
  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const t = o.tools.find((x) => x.name === name)
    if (!t) return `알 수 없는 도구입니다: ${name}`
    o.onStep?.(t.label(args))
    if (typeof args.path === 'string' && name === 'read_file') read.add(args.path)
    try {
      return await t.run(args)
    } catch (e) {
      return `오류: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const wait = (sec: number) => o.onStep?.(`요청 한도 대기 중 (${sec}초)`)

  try {
    if (cfg.provider === 'Anthropic') return { value: await anthropicLoop(), read: [...read] }
    if (cfg.provider === 'Gemini') return { value: await geminiLoop(), read: [...read] }
    return { value: await openaiLoop(), read: [...read] }
  } catch (e) {
    if (toolsUnsupported(e)) throw new ToolsUnsupported(e instanceof Error ? e.message : String(e))
    throw e
  }

  async function anthropicLoop(): Promise<z.infer<T>> {
    const c = new Anthropic({ apiKey: cfg.apiKey })
    const tools: Anthropic.Tool[] = [
      ...o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      { name: o.finalName, description: o.finalDescription, input_schema: finalSchema as Anthropic.Tool.InputSchema }
    ]
    const user = `${o.user}\n\n[작성 언어] 모든 글과 문서 내용은 한국어로 씁니다.`
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]
    for (let step = 0; step < maxSteps + 2; step++) {
      const force = step >= maxSteps
      const res = await retryTransient(
        () => c.messages.create({ model: cfg.model, max_tokens: 16000, system, messages, tools, tool_choice: force ? { type: 'tool', name: o.finalName } : { type: 'any' } }, { signal: o.signal }),
        o.signal,
        wait
      )
      messages.push({ role: 'assistant', content: res.content })
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue
        if (b.name === o.finalName) {
          const v = validate(o.schema, b.input)
          if (v.ok) return v.value
          results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `스키마 검증 실패: ${v.error}. 수정해서 다시 제출하세요.` })
        } else {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: await runTool(b.name, b.input as Record<string, unknown>) })
        }
      }
      if (!results.length) messages.push({ role: 'user', content: `도구를 사용하세요. 다 살펴봤다면 ${o.finalName}로 결과를 제출하세요.` })
      else messages.push({ role: 'user', content: results })
    }
    throw new Error('AI가 정해진 단계 안에 결과를 제출하지 않았습니다.')
  }

  async function openaiLoop(): Promise<z.infer<T>> {
    const c = openai(cfg.provider, cfg.apiKey)
    const tools: OpenAI.ChatCompletionTool[] = [
      ...o.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
      { type: 'function' as const, function: { name: o.finalName, description: o.finalDescription, parameters: finalSchema } }
    ]
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      { role: 'user', content: `${o.user}\n\n[작성 언어] 모든 글과 문서 내용은 한국어로 씁니다.` }
    ]
    const compat = isCompat(cfg.provider)
    for (let step = 0; step < maxSteps + 2; step++) {
      const force = step >= maxSteps
      const res = await retryTransient(
        () =>
          c.chat.completions.create(
            {
              model: cfg.model,
              messages,
              tools,
              tool_choice: force ? { type: 'function', function: { name: o.finalName } } : 'required',
              ...(compat ? { max_tokens: cfg.provider === 'Groq' ? 4000 : 8000 } : {}),
              ...(/gpt-oss/.test(cfg.model) ? { reasoning_effort: 'low' as const } : {})
            },
            { signal: o.signal }
          ),
        o.signal,
        wait
      )
      const msg = res.choices[0]?.message
      if (!msg) throw new Error('AI 응답이 비어 있습니다.')
      const calls = (msg.tool_calls ?? []).filter((x) => x.type === 'function')
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })
      if (!calls.length) {
        messages.push({ role: 'user', content: `도구를 사용하세요. 다 살펴봤다면 ${o.finalName}로 결과를 제출하세요.` })
        continue
      }
      for (const call of calls) {
        let args: Record<string, unknown> = {}
        try {
          args = extractJson(call.function.arguments || '{}') as Record<string, unknown>
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '인자가 올바른 JSON이 아닙니다. 다시 호출하세요.' })
          continue
        }
        if (call.function.name === o.finalName) {
          const v = validate(o.schema, args)
          if (v.ok) return v.value
          messages.push({ role: 'tool', tool_call_id: call.id, content: `스키마 검증 실패: ${v.error}. 수정해서 다시 제출하세요.` })
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: await runTool(call.function.name, args) })
        }
      }
    }
    throw new Error('AI가 정해진 단계 안에 결과를 제출하지 않았습니다.')
  }

  async function geminiLoop(): Promise<z.infer<T>> {
    const g = new GoogleGenAI({ apiKey: cfg.apiKey })
    const decls = [
      ...o.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })),
      { name: o.finalName, description: o.finalDescription, parametersJsonSchema: finalSchema }
    ]
    const contents: Content[] = [{ role: 'user', parts: [{ text: `${o.user}\n\n[작성 언어] 모든 글과 문서 내용은 한국어로 씁니다.` }] }]
    for (let step = 0; step < maxSteps + 2; step++) {
      const force = step >= maxSteps
      const res = await retryTransient(
        () =>
          g.models.generateContent({
            model: cfg.model,
            contents,
            config: {
              systemInstruction: system,
              tools: [{ functionDeclarations: decls }],
              toolConfig: { functionCallingConfig: { mode: 'ANY' as never, ...(force ? { allowedFunctionNames: [o.finalName] } : {}) } },
              maxOutputTokens: 32000,
              abortSignal: o.signal
            }
          }),
        o.signal,
        wait
      )
      const content = res.candidates?.[0]?.content
      if (!content) throw new Error('AI 응답이 비어 있습니다.')
      contents.push(content) // 생각 서명(thought signature)을 보존하려고 받은 그대로 넣는다
      const calls = (content.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall!)
      if (!calls.length) {
        contents.push({ role: 'user', parts: [{ text: `도구를 사용하세요. 다 살펴봤다면 ${o.finalName}로 결과를 제출하세요.` }] })
        continue
      }
      const responses: Content = { role: 'user', parts: [] }
      for (const call of calls) {
        const name = call.name ?? ''
        const args = (call.args ?? {}) as Record<string, unknown>
        let result: string
        if (name === o.finalName) {
          const v = validate(o.schema, args)
          if (v.ok) return v.value
          result = `스키마 검증 실패: ${v.error}. 수정해서 다시 제출하세요.`
        } else {
          result = await runTool(name, args)
        }
        responses.parts!.push({ functionResponse: { id: call.id, name, response: { result } } })
      }
      contents.push(responses)
    }
    throw new Error('AI가 정해진 단계 안에 결과를 제출하지 않았습니다.')
  }
}
