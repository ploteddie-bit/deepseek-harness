---
description: "面向用户与维护者的工作区代码索引说明，用于挂载、设置规模或排查 ctx.codeIndex 与 code_search 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-index

[English](README.md) | 中文

## 概述

`dsh-code-index` 把一个工作区的 TypeScript 与 JavaScript 源码索引进 SQLite，并通过 `ctx.codeIndex` 与 `code_search` 工具提供检索。声明来自 TypeScript AST，文件文本来自 FTS5 trigram 索引，两者与路径匹配融合为按文件的单一排序。索引是显式的：挂载插件不会遍历任何文件，`indexWorkspace()` 执行遍历，在此之前 `search()` 不返回结果。默认的 `:memory:` 数据库每个进程重建；配置 `dbPath` 则持久化索引。不运行任何嵌入模型：实测的瓶颈是定义文件的排序，而不是语义覆盖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 需要按声明名、文件路径或文本短语查找代码，而不是运行 shell `grep` 并读取整个文件时，挂载此插件。它是可选启用：没有任何内置 profile 挂载它，第一次搜索的代价是一次工作区遍历。

### agent 获得的内容

服务是 `ctx.codeIndex`，提供四个方法。

| 方法 | 行为 |
|---|---|
| `indexWorkspace({ force? })` | 遍历工作区、提取符号，并在单个事务中替换整个索引。不带 `force` 时，已索引的工作区直接返回当前状态而不再遍历；`force` 丢弃并重建。并发调用在正在进行的运行上串行。 |
| `search(query, { limit? })` | 返回按分数降序排列的融合结果。第一次索引运行之前不返回结果。 |
| `status()` | 报告覆盖的工作区，以及是否已有一次完整运行记录了 `files`、`symbols` 与 `updatedAt`。 |
| `dispose()` | 关闭数据库；此后每个方法调用都会抛出 `code-index: the service is disposed`。 |

覆盖的工作区是进程启动时的目录，在服务构造时捕获一次；它不是 Session 工作目录，也不跟随之后的目录切换。遍历按名称顺序访问条目，跳过符号链接与被排除的目录名，并收录 `maxFileBytes` 以内的 `.ts`、`.tsx`、`.js` 与 `.mjs` 文件。无法读取的目录，以及在列目录与读取之间消失的文件，都会被跳过而不让本次运行失败。

`code_search` 工具在 `ctx.tools` 已经挂载时注册：Loader 在 apply 时通过 `ctx.get('tools')` 读取该注册表。它在首次调用时索引工作区，因此挂载插件即可使用；不挂载工具注册表的部署永远不会注册工具。

### 配置

每个字段都有默认值，因此空配置行也是有效配置。

```yaml
- name: '@deepseek-ai/dsh-code-index'
  config:
    maxFiles: 20000
    maxFileBytes: 1000000
    exclude: ['.git', 'node_modules', 'lib', 'dist', '.dist', 'build', '.turbo', 'coverage', 'vendor', '.agents']
    dbPath: ':memory:'
```

受支持的字段概览：

```ts
export interface Config {
  maxFiles?: number
  maxFileBytes?: number
  exclude?: string[]
  dbPath?: string
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFiles` | `20000` | 一次索引运行收录的源文件数量上限；遍历到此为止 |
| `maxFileBytes` | `1000000` | 从单个源文件读取的 UTF-8 字节上限；更大的文件被跳过 |
| `exclude` | `['.git', 'node_modules', 'lib', 'dist', '.dist', 'build', '.turbo', 'coverage', 'vendor', '.agents']` | 遍历工作区时跳过的目录名 |
| `dbPath` | `:memory:` | SQLite 数据库路径；`:memory:` 保持索引临时 |

`exclude` 的条目是纯目录名，在任意深度上匹配：包含路径分隔符或只有空白的条目会在加载时失败。`maxFiles` 与 `maxFileBytes` 必须是正安全整数，空白 `dbPath` 同样在加载时失败。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-code-index)是每个受支持字段及其 JSDoc 的权威来源。

### 观察一次索引运行

`status()` 报告 `files`、`symbols` 与 `updatedAt`；`updatedAt` 是最近一次完整替换的 ISO 时间戳，在完成之前保持为 null。每次运行都在单个事务内删除并重新填充两张表，因此失败的运行保留上一次索引，存储层重新抛出 SQLite 错误。

在实际服务中，本仓库自身源码上测得：索引 5 918 个文件与 180 968 个声明耗时 20,79 s，SQLite 文件 208 MB；trigram 文本查询 p50 4,04 ms、p95 8,25 ms，仅符号检索 p50 19,55 ms、p95 24,94 ms。保留的预算是每次运行低于 25 s、p95 低于 50 ms、体积低于 300 MB。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

本节说明插件的设计决策；可观察行为见[使用本包](#use-this-package)。

### 设计理念

索引只擅长回答一个问题：这个名字定义在哪个文件。spike 实测在这个问题上，仅用 FTS5 trigram 文本搜索的 hit@1 为 0,10，而符号表达到 0,53，因此把声明排在无关文本之上正是本包存在的理由。分数是在排序前就固定的层级，而不是相关性模型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`resolveConfig`、服务提供、可选工具注册 |
| [`src/service.ts`](src/service.ts) | `CodeIndexService`：工作区遍历、边界、符号收集、运行串行化 |
| [`src/store.ts`](src/store.ts) | SQLite 存储：FTS5 trigram 表、符号表、运行元数据、替换事务 |
| [`src/symbols.ts`](src/symbols.ts) | 从 TypeScript AST 提取声明 |
| [`src/search.ts`](src/search.ts) | 跨三个匹配来源的分数融合 |
| [`src/tool.ts`](src/tool.ts) | 面向模型的 `code_search` 工具 |
| [`src/types.ts`](src/types.ts) | 共享的 `CodeIndexStatus` 与 `CodeSearchResult` 类型 |

### 主流程

一次运行把每个被收录的文件读取一次，在内存中提取其声明，然后把两份列表交给单个 `replace()` 事务。检索执行四个查询——符号表上的精确、前缀与子串匹配，被索引路径上的子串匹配，以及当查询至少三个字符时的 FTS5 短语匹配——并按路径合并候选取最高分。符号层级为精确 1,0、前缀 0,8、子串 0,6；路径命中为 0,5；文本命中为 `0.4 / (1 + |bm25|)`，因此永远不会排在路径命中之前。每个来源最多读取 `limit × 4` 行，融合后的列表按分数降序、再按路径截断到 `limit`。

### 不变量

服务从不隐式索引，也从不监视文件系统：语料只会在某次运行替换它时改变。已释放的服务拒绝每个调用，而不会重新打开数据库。默认的 `:memory:` 数据库意味着索引不会比构建它的进程活得更久。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读这些页面。它们从选出该排序的决策，到最完整的配置。

- [代码索引服务决策记录](../../../.agents/notes/implemented/feature/2026-10-18-code-index-service.zh.md)——实测预算与该排序排除的替代方案。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-code-index)——每个受支持配置字段及其源声明。
- [上下文组地图](../README.zh.md)——相邻的请求上下文包。

-----

<a id="model-experience"></a> <a id="prompt-shape"></a>
## 模型体验

### 代码搜索工具

#### 模型看到的内容

挂载插件且存在工具注册表时，每个请求都会为该 agent 的工具视图贡献一个工具。描述与两个参数都是固定文本。必需的 `query` 参数被描述为声明名、标识符片段、路径片段或文本短语；可选的数字参数 `limit` 限制返回行数，默认为 10。空白或仅含空白的查询返回无匹配，而不是整个语料。

##### code_search 描述

```markdown
Search the indexed workspace source code: declaration names (exact, prefix, and substring matches), file paths, and full-text phrases, fused into one per-file ranked list.
```

#### Token 影响

工具可见期间，每个请求固定产生一条描述与两条参数描述。该工具不贡献任何系统提示段落，也不贡献自己的 Session 事件。

#### KV Cache 影响

只要可见工具集合及其注册生命周期不变，前缀保持稳定；挂载或卸载插件会从第一个变化的工具 token 起使复用失效。

### 代码搜索结果

#### 模型看到的内容

空结果恰好是 `(no matches in the code index)`。非空结果每条命中一行：保留两位小数的分数、两个空格、工作区相对路径，符号命中还带声明所在行，然后是匹配类型及其细节。符号行以声明名结尾；文本行以首个匹配周围的源码摘录结尾，被截断处用 `…` 标记；路径行没有细节。记录的结果携带结构化字段——`path`、`score`、`kind`，以及 `line`、`symbol` 或 `snippet`——而模型读到的是这份渲染文本。

##### 代码搜索结果文本

```markdown
1.00  packages/context/code-index/src/service.ts:49  symbol  CodeIndexService
0.80  packages/context/code-index/src/store.ts:61  symbol  CodeIndexStore
0.50  packages/context/code-index/src/search.ts  path
```

#### Token 影响

每次调用最多 `limit` 行，默认 10；每段文本摘录在匹配两侧最多显示 60 个字符。重复检索会累积进 Session 历史，直到被压缩。

#### KV Cache 影响

仅追加；结果内容位于可复用前缀之后，不会使已有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制划出索引不适用或需要运维察觉的边界。它们是当前包的约束，不是任务清单。

- **工作区即进程工作目录**——服务在构造时捕获 `process.cwd()`，因此切换目录的 Session 仍检索原来的目录树，服务多个目录树的部署需要每个目录树一个服务。
- **索引是完整且显式的**——`indexWorkspace()` 遍历并替换整个语料，`force` 再做一次，没有文件变化后自动重建。即使配置了 `dbPath`，其中保存的仍是最后一次完整运行的语料。
- **一次运行会阻塞事件循环**——遍历、AST 提取与 SQLite 写入都是同步的。在本仓库上这意味着每次运行阻塞超过 13 s，因此请求内发起的第一次搜索会占住该轮。
- **只索引四种文件后缀**——`.ts`、`.tsx`、`.js` 与 `.mjs`。Python、Rust、Go 及其余所有源文件，还有 Markdown 与 JSON，都不在语料内。
- **声明覆盖很窄**——函数、方法、类、接口、类型别名、枚举，以及一条语句中的第一个具名变量。重导出、没有名称的默认导出、计算成员名与私有成员名、解构模式都不会记录任何内容。
- **短查询跳过文本索引**——FTS5 trigram 无法服务少于三个字符的查询，这类查询只匹配符号与路径。
- **排序是词法的**——没有 camelCase 拆分、词干还原、模糊匹配或嵌入模型。`workspaceChanges` 匹配不到 snake_case 查询；BM25 归一化相对于语料，因此分数在同一次索引运行内可比，跨运行不可比。
- **符号提取仅支持 TypeScript**——AST 路径理解 TypeScript 与 JavaScript；其他语言贡献文件文本，但从不产生符号行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

存储层使用 `node:sqlite` 的 `DatabaseSync`，因此每个查询都是同步的；`indexWorkspace()` 返回 promise 只是为了让并发调用能在正在进行的运行上串行。AST 遍历使用 `ts.createSourceFile` 并启用 `setParentNodes`，这正是 `getStart(sourceFile)` 能用于计算行号的原因。

增加增量运行意味着要在存储层记录逐文件身份，并只替换发生变化的路径；`replace()` 当前会删除两张表，因此部分刷新需要自己的事务，以及关于符号对应文件消失时如何处理的独立决策。

符号层级、路径层级与 BM25 上限是 `src/search.ts` 中导出的常量；改动其中之一就会改变模型可见的排序顺序，须与[决策记录](../../../.agents/notes/implemented/feature/2026-10-18-code-index-service.zh.md)一同处理。

</details>