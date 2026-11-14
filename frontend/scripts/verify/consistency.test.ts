import './storage-shim.ts'
import assert from 'node:assert/strict'

import {
  commitChanges,
  currentSnapshot,
  currentVersion,
  readTable,
  resetTable,
  subscribeVersions,
} from '@/data/version-store'
import {
  validate,
  validateAction,
  validateFilters,
  validateModuleKey,
  validateRowId,
} from '@/data/validation'
import { traceLineagePaths, isReachable, lineageTableNames } from '@/data/lineage'
import {
  confirmLineageChange,
  lineagePaths,
  listEntries,
  listEntriesParallel,
  loadOverview,
  runAction,
  listConfirmations,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

let passed = 0
async function main(): Promise<void> {
  const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
    Promise.resolve(fn()).then(() => {
      passed += 1
      console.log(`  ✓ ${name}`)
    })

  // ---- 1. 基线：不可变的已确认视图 -------------------------------------------------
  await check('基线版本为 v0，快照与行均被冻结', () => {
    const snap = currentSnapshot()
    assert.equal(snap.version, 0)
    assert.ok(Object.isFrozen(snap))
    assert.ok(Object.isFrozen(snap.tables))
    assert.ok(Object.isFrozen(snap.tables.lineage[0]))
    assert.throws(() => {
      ;(snap.tables.lineage[0] as EntryRow).status = 'x'
    }, TypeError)
  })

  await check('读侧拿到的是同一份快照引用，且不能改写', () => {
    const a = readTable('lineage')
    const b = readTable('lineage')
    assert.equal(a, b)
    assert.throws(() => {
      ;(a as unknown as EntryRow[]).push({} as EntryRow)
    }, TypeError)
  })

  // ---- 2. 原子提交：要么一起生效，要么都不生效 --------------------------------------
  await check('一次提交整体推进一个确认版本并留痕', () => {
    const before = currentVersion()
    const lineage = readTable('lineage').map((row) => ({ ...row }))
    lineage[0] = { ...lineage[0], status: '待校验' }
    const result = commitChanges(
      { lineage: lineage },
      {
        key: 'test:atomic-1',
        idempotencyKey: 'idem:atomic-1',
        reason: '原子提交测试',
        createdAt: Date.now(),
        lineageIds: [lineage[0].id],
        schemaIds: [1],
      },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.version, before + 1)
      assert.equal(result.confirmation.lineageIds[0], lineage[0].id)
      assert.equal(readTable('lineage')[0].status, '待校验')
    }
    assert.equal(currentVersion(), before + 1)
  })

  await check('非法变更集整体拒绝，不产生版本', () => {
    const before = currentVersion()
    const bad = commitChanges(
      { lineage: 'not-an-array' as unknown as EntryRow[] },
      {
        key: 'test:bad',
        idempotencyKey: 'idem:bad',
        reason: '应被拒绝',
        createdAt: Date.now(),
        lineageIds: [],
        schemaIds: [],
      },
    )
    assert.equal(bad.ok, false)
    assert.equal(currentVersion(), before)
  })

  // ---- 3. 乐观并发：过期读取不得覆盖新版本 ------------------------------------------
  await check('过期 expectedVersion 提交被冲突拒绝', () => {
    const stale = currentVersion() - 1
    const rows = readTable('schema').map((row) => ({ ...row }))
    rows[0] = { ...rows[0], status: '已生效' }
    const result = commitChanges(
      { schema: rows },
      {
        key: 'test:stale',
        idempotencyKey: 'idem:stale',
        reason: '过期提交',
        createdAt: Date.now(),
        lineageIds: [],
        schemaIds: [rows[0].id],
      },
      { expectedVersion: stale },
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.conflict, true)
      assert.ok(result.message.includes('视图已过期'))
    }
    assert.notEqual(readTable('schema')[0].status, '已生效')
  })

  // ---- 4. 幂等：重复确认不产生新版本 ------------------------------------------------
  await check('相同幂等键重复提交重放首次结果', () => {
    const before = currentVersion()
    const rows = readTable('ods').map((row) => ({ ...row }))
    rows[1] = { ...rows[1], status: '已启用' }
    const record = {
      key: 'test:idem',
      idempotencyKey: 'idem:replay',
      reason: '幂等测试',
      createdAt: Date.now(),
      lineageIds: [],
      schemaIds: [],
    }
    const first = commitChanges({ ods: rows }, record, { idempotencyKey: 'idem:replay' })
    assert.equal(first.ok, true)
    const afterFirst = currentVersion()
    assert.equal(afterFirst, before + 1)

    const second = commitChanges(
      { ods: rows.map((row) => ({ ...row, status: '草稿' })) },
      { ...record, key: 'test:idem-2' },
      { idempotencyKey: 'idem:replay' },
    )
    assert.equal(second.ok, true)
    if (second.ok) {
      assert.equal(second.idempotent, true)
      assert.equal(second.version, afterFirst)
    }
    // 第二次携带的“草稿”内容没有覆盖第一次的结果
    assert.equal(readTable('ods')[1].status, '已启用')
    assert.equal(currentVersion(), afterFirst)
  })

  // ---- 5. 血缘联合确认：关系修改与字段版本同版本生效 --------------------------------
  await check('confirmLineageChange 同时写关系状态与字段确认流水', () => {
    const before = currentVersion()
    const result = confirmLineageChange(2, '启用关系')
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.equal(result.viewVersion, before + 1)
    const relation = readTable('lineage').find((row) => Number(row.id) === 2)
    assert.equal(relation?.status, '已启用')
    const book = listConfirmations().items
    const latest = [...book].sort((a, b) => b.version - a.version)[0]
    assert.deepEqual([...latest.lineageIds], [2])
    assert.ok(latest.reason.includes('字段版本'))
  })

  await check('重复血缘确认保持幂等，不产生新版本', () => {
    const disable = confirmLineageChange(2, '停用关系')
    assert.equal(disable.ok, true)
    const enable1 = confirmLineageChange(2, '启用关系')
    assert.equal(enable1.ok, true)
    const versionAfterEnable = currentVersion()

    // 业务级幂等：同视图紧接着重复同一动作，状态已是目标态，短路且不产生新版本
    const replay = runAction('lineage', 2, '启用关系', {
      expectedVersion: versionAfterEnable,
    })
    assert.equal(replay.ok, false)
    assert.ok(replay.message.includes('不用重复操作'))
    assert.equal(currentVersion(), versionAfterEnable)

    // 请求级幂等：用调用方提供的稳定幂等键重放一次请求，存储层重放首次提交而不涨版本
    const rows = readTable('lineage').map((row) => ({ ...row }))
    const stableKey = 'request-retry:lineage:2:enable'
    const first = commitChanges(
      { lineage: rows },
      {
        key: 'test:request-idem-1',
        idempotencyKey: stableKey,
        reason: '带稳定键的确认',
        createdAt: Date.now(),
        lineageIds: [2],
        schemaIds: [],
      },
      { idempotencyKey: stableKey },
    )
    assert.equal(first.ok, true)
    const versionAfterFirst = currentVersion()
    const retried = commitChanges(
      { lineage: rows },
      {
        key: 'test:request-idem-2',
        idempotencyKey: stableKey,
        reason: '同一请求的重试',
        createdAt: Date.now(),
        lineageIds: [2],
        schemaIds: [],
      },
      { idempotencyKey: stableKey },
    )
    assert.equal(retried.ok, true)
    if (retried.ok) assert.equal(retried.idempotent, true)
    assert.equal(currentVersion(), versionAfterFirst)

    // 不同事务（停用后再启用）身份不同，仍能正常生效
    const disableAgain = confirmLineageChange(2, '停用关系')
    assert.equal(disableAgain.ok, true)
    assert.equal(currentVersion(), versionAfterFirst + 1)
  })

  // ---- 6. 并行只读查询与版本一致 ----------------------------------------------------
  await check('无关表只读查询可并行，且返回同一确认版本', async () => {
    const [ods, dwd, lineage] = await listEntriesParallel([
      { key: 'ods' },
      { key: 'dwd' },
      { key: 'lineage' },
    ])
    assert.equal(ods.viewVersion, dwd.viewVersion)
    assert.equal(dwd.viewVersion, lineage.viewVersion)
    assert.equal(ods.viewVersion, currentVersion())
  })

  await check('订阅器能收到版本推进通知，且通知里是新快照', () => {
    const seen: number[] = []
    const off = subscribeVersions((snap) => seen.push(snap.version))
    resetTable('dws')
    assert.ok(seen.includes(currentVersion()))
    off()
  })

  // ---- 7. 血缘可达路径核对 ----------------------------------------------------------
  await check('可达路径在确认视图上按已启用关系遍历', () => {
    const rows = readTable('lineage').map((row) => ({ ...row }))
    rows.push(
      {
        id: 101, status: '已启用', pending: false, abnormal: false,
        关系编号: 'LINE-0101', 上游表名: 'table_a', 下游表名: 'table_b',
        来源字段: 'f', 目标字段: 'f', 转换函数: 'id', 采集批次: 'b1', 关系版本: 'v1',
      },
      {
        id: 102, status: '已启用', pending: false, abnormal: false,
        关系编号: 'LINE-0102', 上游表名: 'table_b', 下游表名: 'table_c',
        来源字段: 'f', 目标字段: 'f', 转换函数: 'id', 采集批次: 'b1', 关系版本: 'v1',
      },
      {
        id: 103, status: '草稿', pending: true, abnormal: false,
        关系编号: 'LINE-0103', 上游表名: 'table_c', 下游表名: 'table_d',
        来源字段: 'f', 目标字段: 'f', 转换函数: 'id', 采集批次: 'b1', 关系版本: 'v1',
      },
    )
    const v = currentVersion()
    commitChanges(
      { lineage: rows },
      {
        key: 'test:graph', idempotencyKey: 'idem:graph', reason: '构造血缘图',
        createdAt: Date.now(), lineageIds: [101, 102, 103], schemaIds: [],
      },
      { expectedVersion: v },
    )

    const paths = traceLineagePaths('table_a', 'table_c')
    assert.equal(paths.length, 1)
    assert.equal(paths[0].hops.length, 2)
    assert.equal(paths[0].hasUnconfirmed, false)
    assert.equal(isReachable('table_a', 'table_c'), true)
    assert.equal(isReachable('table_a', 'table_d'), false)

    const withUnconfirmed = traceLineagePaths('table_a', 'table_d', {
      includeUnconfirmed: true,
    })
    assert.equal(withUnconfirmed.length, 1)
    assert.equal(withUnconfirmed[0].hasUnconfirmed, true)

    // 环不会导致死循环
    const cyclic = readTable('lineage').map((row) => ({ ...row }))
    cyclic.push({
      id: 104, status: '已启用', pending: false, abnormal: false,
      关系编号: 'LINE-0104', 上游表名: 'table_c', 下游表名: 'table_a',
      来源字段: 'f', 目标字段: 'f', 转换函数: 'id', 采集批次: 'b1', 关系版本: 'v1',
    })
    const v2 = currentVersion()
    commitChanges(
      { lineage: cyclic },
      {
        key: 'test:cycle', idempotencyKey: 'idem:cycle', reason: '加环',
        createdAt: Date.now(), lineageIds: [104], schemaIds: [],
      },
      { expectedVersion: v2 },
    )
    const limited = traceLineagePaths('table_a', 'table_c', { maxPaths: 5 })
    assert.ok(limited.length >= 1 && limited.length <= 5)
    assert.ok(lineageTableNames().includes('table_a'))
    assert.equal(lineagePaths('table_a', 'table_c').viewVersion, currentVersion())
  })

  // ---- 8. 统一校验入口 --------------------------------------------------------------
  await check('读写两类校验共用 validate 入口，失败形状一致', () => {
    const okModule = validateModuleKey('lineage')
    assert.equal(okModule.ok, true)
    const badModule = validateModuleKey('nope')
    assert.equal(badModule.ok, false)
    if (!badModule.ok) assert.ok(badModule.message.includes('没有登记名为'))

    const okFilters = validateFilters({ 关系编号: 'LINE' })
    assert.equal(okFilters.ok, true)
    const badFilters = validateFilters({ x: 1 as unknown as string })
    assert.equal(badFilters.ok, false)

    const meta = (okModule.ok ? okModule.value : null)!
    const okAction = validateAction(meta, '启用关系')
    assert.equal(okAction.ok, true)
    const badAction = validateAction(meta, '删除关系')
    assert.equal(badAction.ok, false)

    const okId = validateRowId(meta, 1, new Set([1, 2]))
    assert.equal(okId.ok, true)
    const badId = validateRowId(meta, 99, new Set([1, 2]))
    assert.equal(badId.ok, false)

    const direct = validate({
      value: '',
      isValid: (text) => text.length > 0,
      message: '不能为空',
    })
    assert.equal(direct.ok, false)
  })

  // ---- 9. 服务层既有行为保持：中文字段、状态、动作结果 --------------------------------
  await check('列表/动作/概览的中文结果与动作消息保持原样', () => {
    const page = listEntries('lineage')
    assert.equal(page.total, readTable('lineage').length)
    assert.ok(page.items.every((row) => typeof row['关系编号'] === 'string'))

    // 用一张刚重置的表获得确定的初始状态，避免被前面检查的流转影响
    resetTable('dwd')
    const target = readTable('dwd').find((row) => Number(row.id) === 1)!
    assert.notEqual(String(target.status), '已启用')
    const baseVersion = currentVersion()
    const result = runAction('dwd', Number(target.id), '启用建模', {
      expectedVersion: baseVersion,
    })
    assert.equal(result.ok, true)
    assert.ok(result.message!.includes('已启用建模'))
    const updated = readTable('dwd').find((row) => Number(row.id) === Number(target.id))
    assert.equal(updated?.status, '已启用')
    // pending 的口径与重构前一致：目标状态不是状态表最后一项时仍为 true（已启用≠已停用）
    const lastStatus = '已停用'
    assert.equal(updated?.pending, '已启用' !== lastStatus)

    // 重复确认保持幂等：无论返回成功重放还是业务短路，状态与确认版本都不再变化
    const versionAfter = currentVersion()
    const duplicate = runAction('dwd', Number(target.id), '启用建模', {
      expectedVersion: versionAfter,
    })
    if (duplicate.ok) {
      // 请求级幂等重放：成功但不产生新版本
      assert.equal(duplicate.viewVersion, versionAfter)
    } else {
      // 业务级短路：行已是目标状态
      assert.ok(duplicate.message!.includes('不用重复操作'))
    }
    assert.equal(currentVersion(), versionAfter)
    assert.equal(
      readTable('dwd').find((row) => Number(row.id) === Number(target.id))?.status,
      '已启用',
    )

    const unknown = runAction('dwd', 9999, '启用建模')
    assert.equal(unknown.ok, false)
    assert.ok(unknown.message!.includes('没有找到编号'))

    const overview = loadOverview()
    assert.equal(overview.viewVersion, currentVersion())
    assert.ok(overview.cards.some((card) => card.label === '业务模块'))
  })

  // ---- 10. 持久化与刷新 --------------------------------------------------------------
  await check('版本号与确认记录已持久化，供下一进程（模拟刷新）核对', () => {
    assert.ok(currentVersion() >= 6)
    assert.ok(listConfirmations().items.length >= 3)
  })

  console.log(`\n进程一全部通过：${passed} 项检查，最终确认版本 v${currentVersion()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
