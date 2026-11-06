// Monaco를 CDN이 아닌 로컬 패키지에서 불러오도록 설정 (오프라인·CSP 대응)
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
// 아이콘 글꼴 (diff의 +/− 표시, 숨긴 줄 펼치기 버튼 등)
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

monaco.editor.defineTheme('docsync', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#37352f',
    'editorLineNumber.foreground': '#b9b8b4',
    'editorLineNumber.activeForeground': '#73726e',
    'editor.lineHighlightBackground': '#f7f7f5',
    'editor.selectionBackground': '#cfe3f7',
    'editorGutter.background': '#ffffff',
    // GitHub diff 색
    'diffEditor.insertedLineBackground': '#e6ffec',
    'diffEditor.insertedTextBackground': '#abf2bcaa',
    'diffEditor.removedLineBackground': '#ffebe9',
    'diffEditor.removedTextBackground': '#ffcecbaa',
    'diffEditorGutter.insertedLineBackground': '#ccffd8',
    'diffEditorGutter.removedLineBackground': '#ffd7d5',
    'diffEditor.unchangedRegionBackground': '#f6f8fa',
    'diffEditor.diagonalFill': '#00000000'
  }
})

loader.config({ monaco })

export function languageOf(path: string): string {
  if (/\.(md|markdown|mdx)$/i.test(path)) return 'markdown'
  if (/\.tsx?$/i.test(path)) return 'typescript'
  if (/\.jsx?$/i.test(path)) return 'javascript'
  if (/\.json$/i.test(path)) return 'json'
  if (/\.ya?ml$/i.test(path)) return 'yaml'
  if (/\.html?$/i.test(path)) return 'html'
  if (/\.css$/i.test(path)) return 'css'
  return 'plaintext'
}

export const editorBaseOptions = {
  fontSize: 13,
  lineHeight: 20,
  fontFamily: '"JetBrains Mono", "D2Coding", Consolas, ui-monospace, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'on' as const,
  renderLineHighlight: 'line' as const,
  overviewRulerBorder: false,
  padding: { top: 10, bottom: 10 },
  automaticLayout: true
}

/** 페이지 안에 박힌 작은 편집기·diff용: 편집기 끝에 닿으면 휠이 바깥 화면을 스크롤하도록 */
export const embeddedEditorOptions = {
  ...editorBaseOptions,
  scrollbar: { alwaysConsumeMouseWheel: false }
}
