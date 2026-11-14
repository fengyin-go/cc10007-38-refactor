// 浏览器环境垫片：用临时文件做 localStorage 后端，两个独立进程可模拟「页面刷新」。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const BACKING_FILE = process.env.DLS_STORAGE_FILE ?? '/tmp/dls-verify/storage.json'
mkdirSync('/tmp/dls-test', { recursive: true })

const memory: Record<string, string> = existsSync(BACKING_FILE)
  ? (JSON.parse(readFileSync(BACKING_FILE, 'utf8')) as Record<string, string>)
  : {}

function flush() {
  writeFileSync(BACKING_FILE, JSON.stringify(memory))
}

const localStorageShim = {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null
  },
  setItem(key: string, value: string): void {
    memory[key] = String(value)
    flush()
  },
  removeItem(key: string): void {
    delete memory[key]
    flush()
  },
  clear(): void {
    for (const key of Object.keys(memory)) delete memory[key]
    flush()
  },
}

;(globalThis as Record<string, unknown>).localStorage = localStorageShim
;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }
