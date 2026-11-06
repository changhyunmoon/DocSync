// AI에게 주는 읽기 전용 프로젝트 도구와 폴더 구조 요약
import type { TreeNode } from '@shared/types'
import type { AgentTool } from '../ai/agent'
import { ProjectFs, inScope } from './projectFs'

const READ_LIMIT = 12_000

/** 프롬프트용 폴더 구조 (들여쓰기 트리). 반영 범위 폴더에 표시를 단다 */
export async function folderTree(fs: ProjectFs, scope: string[], maxLines = 400): Promise<string> {
  const tree = await fs.tree()
  const lines: string[] = []
  const walk = (ns: TreeNode[], depth: number): void => {
    for (const n of ns) {
      if (lines.length >= maxLines) return
      const mark = scope.includes(n.path) ? '  ← 반영 범위' : ''
      lines.push(`${'  '.repeat(depth)}${n.name}${n.dir ? '/' : ''}${mark}`)
      if (n.dir) walk(n.children ?? [], depth + 1)
    }
  }
  walk(tree, 0)
  if (lines.length >= maxLines) lines.push('… (이하 생략, list_dir로 확인)')
  return lines.join('\n')
}

export function projectTools(fs: ProjectFs, scope: string[]): AgentTool[] {
  const norm = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  return [
    {
      name: 'list_dir',
      description: '프로젝트 폴더의 파일·하위 폴더 목록을 봅니다. path는 프로젝트 루트 기준 경로이며 빈 문자열이면 루트입니다.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '폴더 경로 (예: docs, docs/auth). 루트는 빈 문자열' } }, required: ['path'] },
      label: (a) => `폴더 살펴보는 중 · ${norm(a.path) || '/'}`,
      async run(a) {
        const p = norm(a.path)
        const all = await fs.tree()
        const find = (ns: TreeNode[]): TreeNode[] | null => {
          if (!p) return ns
          for (const n of ns) {
            if (n.path === p && n.dir) return n.children ?? []
            if (n.dir && p.startsWith(n.path + '/')) return find(n.children ?? [])
          }
          return null
        }
        const list = find(all)
        if (!list) return `폴더가 없습니다: ${p}`
        const out: string[] = []
        for (const n of list.slice(0, 300)) {
          if (n.dir) out.push(`${n.name}/  (${(n.children ?? []).length}개 항목)`)
          else {
            const c = ProjectFs.isTextDoc(n.path) ? await fs.read(n.path) : null
            out.push(`${n.name}${c != null ? `  (${c.length}자)` : ''}${inScope(n.path, scope) ? '' : '  [반영 범위 밖]'}`)
          }
        }
        return out.join('\n') || '(비어 있음)'
      }
    },
    {
      name: 'read_file',
      description: `텍스트 파일 내용을 읽습니다. 긴 파일은 ${READ_LIMIT}자까지만 돌려주며, offset으로 이어서 읽을 수 있습니다. 내용은 가공 없이 원문 그대로입니다.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로 (예: docs/auth/login.md)' },
          offset: { type: 'number', description: '읽기 시작 위치(문자 수). 처음부터면 0' }
        },
        required: ['path']
      },
      label: (a) => `문서 읽는 중 · ${norm(a.path)}`,
      async run(a) {
        const p = norm(a.path)
        const c = await fs.read(p)
        if (c == null) return `파일이 없습니다: ${p}`
        const off = Math.max(0, Number(a.offset) || 0)
        const part = c.slice(off, off + READ_LIMIT)
        const more = off + READ_LIMIT < c.length ? `\n\n[… ${c.length - off - READ_LIMIT}자 더 있음. offset=${off + READ_LIMIT}로 이어 읽기]` : ''
        return `${inScope(p, scope) ? '' : '[반영 범위 밖 파일 — 읽기만 가능, 수정 금지]\n'}${part}${more}`
      }
    },
    {
      name: 'search',
      description: '프로젝트의 텍스트 문서(.md, .txt 등)에서 단어를 찾습니다. 대소문자 구분 없음. 관련 문서를 찾을 때 씁니다.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '찾을 단어나 문장' }, path: { type: 'string', description: '이 폴더 안에서만 찾기 (선택)' } },
        required: ['query']
      },
      label: (a) => `문서 검색 중 · "${String(a.query ?? '').slice(0, 30)}"`,
      async run(a) {
        const q = String(a.query ?? '').trim().toLowerCase()
        if (!q) return '검색어가 비어 있습니다.'
        const base = norm(a.path)
        const files = (await fs.allFiles()).filter((f) => ProjectFs.isTextDoc(f) && (!base || f === base || f.startsWith(base + '/')))
        const hits: string[] = []
        for (const f of files) {
          const c = await fs.read(f)
          if (!c) continue
          c.split('\n').forEach((line, i) => {
            if (hits.length < 60 && line.toLowerCase().includes(q)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
          })
          if (hits.length >= 60) break
        }
        return hits.length ? hits.join('\n') : '찾은 결과가 없습니다.'
      }
    }
  ]
}
