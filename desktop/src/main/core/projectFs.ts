// 프로젝트 폴더 접근. 모든 경로는 루트 기준 posix 상대 경로로 다루고, 루트 밖 접근은 막는다.
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { TreeNode } from '@shared/types'
import type { FsLike } from './engine'

export const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'release', 'build', '.next', '.cache', '.idea', '.vscode', 'coverage'])
const TEXT_EXT = /\.(md|markdown|mdx|txt)$/i

export class ProjectFs implements FsLike {
  constructor(public readonly root: string) {}

  abs(rel: string): string {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    const full = path.resolve(this.root, clean)
    const r = path.relative(this.root, full)
    if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`프로젝트 밖 경로입니다: ${rel}`)
    return full
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/')
  }

  async read(rel: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.abs(rel), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  /** 임시 파일에 쓴 뒤 rename으로 교체 (중간 상태의 파일이 남지 않도록) */
  async write(rel: string, content: string): Promise<void> {
    const full = this.abs(rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    const tmp = `${full}.docsync-${process.pid}-${Date.now()}.tmp`
    await fsp.writeFile(tmp, content, 'utf8')
    try {
      await fsp.rename(tmp, full)
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      throw e
    }
  }

  async remove(rel: string): Promise<void> {
    const full = this.abs(rel)
    await fsp.rm(full, { force: true })
    // 이동으로 비게 된 상위 폴더 하나는 정리한다 (비어 있지 않으면 rmdir이 실패하므로 안전)
    const parent = path.dirname(full)
    if (parent !== this.root) await fsp.rmdir(parent).catch(() => undefined)
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(rel))
      return true
    } catch {
      return false
    }
  }

  async mkdir(rel: string): Promise<void> {
    await fsp.mkdir(this.abs(rel), { recursive: true })
  }

  async removeEntry(rel: string): Promise<void> {
    await fsp.rm(this.abs(rel), { recursive: true, force: true })
  }

  async tree(dir = '', depth = 0): Promise<TreeNode[]> {
    if (depth > 12) return []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(this.abs(dir), { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: TreeNode[] = []
    for (const e of entries) {
      if (IGNORED.has(e.name) || e.name.startsWith('.docsync') || e.name.endsWith('.tmp')) continue
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) nodes.push({ path: rel, name: e.name, dir: true, children: await this.tree(rel, depth + 1) })
      else if (e.isFile()) nodes.push({ path: rel, name: e.name, dir: false })
    }
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return nodes
  }

  async allFiles(): Promise<string[]> {
    const out: string[] = []
    const visit = (ns: TreeNode[]): void => {
      for (const n of ns) {
        if (n.dir) visit(n.children ?? [])
        else out.push(n.path)
      }
    }
    visit(await this.tree())
    return out
  }

  static isTextDoc(p: string): boolean {
    return TEXT_EXT.test(p)
  }

  static isMarkdown(p: string): boolean {
    return /\.(md|markdown|mdx)$/i.test(p)
  }
}

export function inScope(p: string, scope: string[]): boolean {
  if (!scope.length) return true
  return scope.some((s) => p === s || p.startsWith(s + '/'))
}
