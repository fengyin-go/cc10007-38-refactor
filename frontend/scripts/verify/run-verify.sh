#!/usr/bin/env bash
# 数据访问边界一致性验证：
# 1) consistency.test.ts —— 不可变快照、原子提交、乐观并发、幂等、并行只读、血缘可达路径、统一校验
# 2) refresh-check.ts    —— 全新进程模拟页面刷新，版本与确认记录必须完整保留
# 3) migration-check.ts  —— 旧版无版本 localStorage 平滑迁移为首个确认视图
# 仅依赖仓库已有的 esbuild，不引入测试框架。
set -euo pipefail

cd "$(dirname "$0")/../.."

WORK_DIR="${DLS_VERIFY_DIR:-/tmp/dls-verify}"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

bundle() {
  npx esbuild "scripts/verify/$1" \
    --bundle --platform=node --format=esm \
    --alias:@=./src --outfile="$WORK_DIR/$2"
}

bundle consistency.test.ts bundle-consistency.mjs
bundle refresh-check.ts bundle-refresh.mjs
bundle migration-check.ts bundle-migration.mjs

echo '== 1/3 一致性保证 =='
DLS_STORAGE_FILE="$WORK_DIR/storage.json" node "$WORK_DIR/bundle-consistency.mjs"

echo '== 2/3 页面刷新（全新进程，同一 localStorage）=='
DLS_STORAGE_FILE="$WORK_DIR/storage.json" node "$WORK_DIR/bundle-refresh.mjs"

echo '== 3/3 旧版存储迁移 =='
DLS_STORAGE_FILE="$WORK_DIR/storage-migration.json" node "$WORK_DIR/bundle-migration.mjs"

echo
echo '全部验证通过。'
