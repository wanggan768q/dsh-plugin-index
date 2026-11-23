# dsh-plugin-index

DeepSeek Harness 的插件市场索引（format 1）。

索引地址：

```text
https://wanggan768q.github.io/dsh-plugin-index/index.json
```

在 DSH 中打开 **插件** → 打开实验性的 **自定义插件索引** → **发现** → **添加索引源**，粘贴上面的地址。

## 收录的插件

| 插件 | 版本 | 来源 |
|---|---|---|
| `dsh-discover-agents` — 工作区 Agent 发现 | 1.2.0 | [wanggan768q/dsh-discover-agents](https://github.com/wanggan768q/dsh-discover-agents) @ `c425ca80180c68bf34a77ff2d573e2582893a733` |

该插件未发布到 npm，只能从 Git 提交安装；索引里的版本固定到具体提交，因此内容不会随分支漂移。

## 目录

```text
index.json                     索引文档（format 1），由 sync 脚本生成版本条目
sources.json                   上游插件仓库清单，唯一需要人工维护的同步配置
icons/                         插件图标，相对 index.json 解析
tools/sync-index.mjs           按上游 release tag 重写 index.json 的 versions[]
tools/fetch-sources.mjs        CI 里把上游仓库克隆到本地目录
tools/validate-index.mjs       用 DSH 官方校验器验证 index.json
.github/workflows/sync-index.yml
```

## 自动同步

`.github/workflows/sync-index.yml` 在下面三种情况重建 `index.json`：

| 触发 | 说明 |
|---|---|
| `repository_dispatch`（`upstream-release`） | 上游插件仓库发版后主动调用，秒级完成，是快路径 |
| `schedule`（每天 02:17 UTC） | 兜底，漏掉 dispatch 或手工推 tag 也能补上 |
| `workflow_dispatch` | 手动运行，可选只同步某个插件 |

工作流只在有上游版本未收录时才提交，所以多数运行是空转。它不会改动 `title`、`description`、`icon` 这些人工字段，只往 `versions[]` 追加。

### 让上游仓库触发同步

在插件仓库（例如 `dsh-discover-agents`）里加一个发版后触发的 job：

```yaml
- name: Notify the plugin index
  env:
    INDEX_TOKEN: ${{ secrets.INDEX_DISPATCH_TOKEN }}
  run: |
    curl -fsSL -X POST \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${INDEX_TOKEN}" \
      https://api.github.com/repos/wanggan768q/dsh-plugin-index/dispatches \
      -d '{"event_type":"upstream-release","client_payload":{"plugin":"dsh-discover-agents"}}'
```

`INDEX_DISPATCH_TOKEN` 是一个对 `dsh-plugin-index` 有 `contents: write` 权限的 fine-grained PAT。没配也照样能用：每天的计划任务会自动补上。

## 本地操作

```bash
npm ci                 # 安装校验器
npm run sync           # 从 ../<上游目录> 读取 tag 并重写 index.json
npm run sync -- --dry-run
npm run validate       # 用 DSH 的 parseMarketIndex 校验
```

`sync` 默认到本仓库的**上级目录**找上游仓库，即 `E:\Git\dsh-plugin-index` 对应 `E:\Git\dsh-discover-agents`。换个位置时用环境变量：

```bash
DSH_INDEX_SOURCE_ROOT=/path/to/checkouts npm run sync
```

本地想保留工作副本、不让脚本重新克隆，跑 `node tools/fetch-sources.mjs --keep-existing`。

### 新增一个插件

1. 在 `sources.json` 加一条：`"<npm 包名>": { "url": "<仓库地址>", "directory": "<本地目录名>" }`。
2. 在 `index.json` 手写该插件的 `plugins[]` 条目，填好 `title`、`description`、`icon`、`metadata`，`versions` 留空数组即可，脚本会填。
3. 跑 `npm run sync`，再做 `npm run validate`。

## 同步规则

脚本按标签名匹配 SemVer（`v1.2.0` 与 `1.2.0` 都认），并逐条校验后才收录：

- 标签指向的提交必须在 `HEAD` 的历史里，否则跳过 —— 避免索引固定到无法 clone 的 SHA。
- 该提交的 `package.json` 版本必须与标签一致，否则跳过。
- 所有有效标签都会被补录，不只是最新一个。
- `engines.dsh` 换到另一个 DSH 小版本线时，同步会失败并要求在 `sources.json` 里给该源加 `"allowMajor": true`。这个范围变化应该由人确认，不能被一个 tag 悄悄改掉。

## 格式规则

完整规则见 DSH 文档 `docs/user/guide/plugin-market.zh.md` 的「索引格式参考」。几条容易踩的：

- `format` 必须是 `1`；`title` 必须有 `en` 键。
- `name` 是 npm 包名格式，索引内唯一。
- `homepage` 可带 `#readme`；`repository.url` 与 Git 来源的 `url` 不能带查询串或片段。
- Git 来源的 `commit` 必须是 40 位小写十六进制 SHA，`path` 是仓库内相对目录。
- `icons/` 图标按索引 URL 相对解析；指向其他源的绝对图标必须用 `https:`。
- `metadata` 里的 `category`、`labels`、`sortKeys` 只能引用根级 `metadata` 声明过的 id。

## 免责声明

索引内容由本仓库维护，DSH 只校验格式、不验证声明。安装前请核对来源。
