import './storage-shim.ts'
import assert from 'node:assert/strict'

// 单独的存储文件，模拟老版本用户：localStorage 里只有无版本号的旧键。
const shim = (globalThis as unknown as { localStorage: Storage }).localStorage
shim.clear()
shim.setItem(
  'data-layer-studio:entries',
  JSON.stringify({
    ods: [
      {
        id: 1, status: '已启用', pending: false, abnormal: false,
        表编号: 'ODS-OLD', 源表名称: '旧数据', 目标表名: 't', 同步模式: '全量',
        分区字段: 'dt', 保留天数: '7', 字段映射: 'm', 增量水位: 'w',
      },
    ],
  }),
)

const { currentVersion, currentSnapshot } = await import('@/data/version-store')
assert.equal(currentVersion(), 1, '旧数据迁移后应成为首个确认版本 v1')
const migrated = currentSnapshot().tables.ods[0]
assert.equal(migrated['表编号'], 'ODS-OLD', '用户已有改动不能丢')
assert.ok(Object.isFrozen(migrated), '迁移后的视图同样不可变')

// 新键已写入，旧键保留备份不被破坏。
assert.ok(shim.getItem('data-layer-studio:versioned') !== null)
assert.ok(shim.getItem('data-layer-studio:entries') !== null)

console.log('旧版无版本存储迁移通过：用户数据保留，升级为不可变确认视图 v1')
