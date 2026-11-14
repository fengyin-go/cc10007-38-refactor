import './storage-shim.ts'
import assert from 'node:assert/strict'

import { currentSnapshot, currentVersion, readConfirmations, readTable } from '@/data/version-store'

// 模拟页面刷新后的全新进程：内存缓存为空，一切从 localStorage 重新装载。
const version = currentVersion()
assert.ok(version >= 6, `刷新后版本应延续，实际 v${version}`)

const snap = currentSnapshot()
assert.equal(snap.version, version)
assert.ok(Object.isFrozen(snap))
assert.ok(Object.isFrozen(snap.tables.lineage))

const confirmations = readConfirmations()
assert.ok(confirmations.length >= 3, '确认流水应随持久化保留')
assert.ok(
  confirmations.every((item) => item.version > 0 && item.baseVersion >= 0),
  '确认记录的版本链应完整',
)

// 前一进程构造的血缘链路在刷新后仍可核对。
const lineage = readTable('lineage')
assert.ok(lineage.some((row) => row['上游表名'] === 'table_a' && row['下游表名'] === 'table_b'))

console.log(`刷新校验通过：新版本 v${version} 与 ${confirmations.length} 条确认记录完整保留，快照仍为只读`)
