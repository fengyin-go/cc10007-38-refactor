# 数据分层建模工作台

离线版数仓分层建模工具，覆盖贴源层、明细层、汇总层、应用层的表结构设计、分区策略配置、质量规则编排与血缘关系管理，数据持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的版本化数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
都以**不可变确认快照**的形式持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。
读侧永远只在某个已确认版本上查询，写侧通过原子提交推进新版本，关系修改与字段版本确认要么
一起生效、要么都不生效。dev server 已关掉自动打开页面，启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：快照查询、原子确认、导出、血缘路径
│   ├── src/data/             版本化访问边界 / 模块元数据 / 示例数据
│   │   ├── version-store.ts       不可变快照、原子提交、乐观并发、幂等、localStorage 持久化
│   │   ├── validation.ts          读写两侧共用的统一校验入口
│   │   ├── lineage.ts             血缘可达路径核对（在确认视图上做图遍历）
│   │   ├── modules.ts / seed.ts / types.ts
│   ├── src/components/       VersionBadge 等跨页面组件
│   ├── scripts/verify/       一致性验证（快照、原子性、并发、幂等、刷新、旧存储迁移）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 贴源层建模 | `ods` | 贴源表 | 表编号、源表名称、目标表名 |
| 明细层建模 | `dwd` | 明细表 | 表编号、业务域、明细表名 |
| 汇总层建模 | `dws` | 汇总表 | 表编号、汇总主题、聚合维度 |
| 应用层发布 | `ads` | 应用数据集 | 数据集编号、业务应用、输出表名 |
| 数据源管理 | `source` | 数据源连接 | 连接编号、连接类型、接入地址 |
| 分区策略 | `partition` | 分区方案 | 方案编号、目标表名、分区字段 |
| 清洗加工 | `cleanse` | 清洗规则 | 规则编号、输入表名、目标表名 |
| 转换编排 | `transform` | 转换节点 | 节点编号、输入表名、输出表名 |
| 质量校验 | `quality` | 质量规则 | 规则编号、校验表名、目标字段 |
| 血缘追踪 | `lineage` | 血缘关系 | 关系编号、上游表名、下游表名 |
| 历史补数 | `backfill` | 补数任务 | 任务编号、目标表名、开始日期 |
| 元数据管理 | `schema` | 字段定义 | 字段编号、所属表名、字段名称 |
| 数据同步 | `datasync` | 同步链路 | 链路编号、源端连接、目标端连接 |
| 快照管理 | `snapshot` | 快照策略 | 策略编号、目标表名、快照周期 |
| 存储治理 | `govern` | 治理策略 | 策略编号、目标表名、治理类型 |
| 任务监控 | `monitor` | 监控配置 | 配置编号、关联任务、监控指标 |
| 变更审计 | `audit` | 审计记录 | 记录编号、操作表名、变更类型 |
| 编目检索 | `catalog` | 编目条目 | 条目编号、数据集名称、所属分层 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 读写两侧的入参校验统一走 `frontend/src/data/validation.ts` 的 `validate()` 入口，
  返回 `{ ok, value/message }`，不再各写各的判断。
- 想回到初始数据：清掉浏览器里 `data-layer-studio:versioned` 这一项，或调用
  `resetModule(模块)`。旧键 `data-layer-studio:entries` 会在首次打开时自动迁移为
  确认版本 v1，原数据不丢。

## 一致性保证（已确认视图）

- **不可变快照**：每次确认提交生成全新的 `DataSnapshot`（深冻结），读侧只在快照上查询，
  编辑过程不会暴露「改了一半」的可变列表。
- **原子提交**：一次提交里的多张表（血缘关系修改 + 字段版本确认）要么一起生效要么都不生效。
- **乐观并发**：写请求携带读取时的 `expectedVersion`，基于过期视图的提交被明确拒绝，
  不会覆盖新版本。
- **幂等确认**：相同 `idempotencyKey` 的重复确认重放首次结果，不产生新版本；
  行已处于目标状态时业务校验短路，同样不再推进版本。
- **并行只读**：无关表各自取同一份快照并行查询，返回结果带 `viewVersion`；
  页面用 `VersionBadge` 明确标注当前视图对应的确认版本，视图过期会提示而不是靠全局刷新掩盖。
- **血缘回看**：`lineage.ts` 以血缘追踪为主对象，在确认视图上核对可达路径，
  支持「仅已启用」与「含未确认关系」两种遍历范围，并对环路做了防护。

一致性验证（不引入测试框架，仅用 esbuild 打包后由 Node 执行）：

```bash
cd frontend
npm run verify
```

领域：数据工程
子方向：数仓与数据湖
