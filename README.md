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

这些插件未发布到 npm，只能从 Git 提交安装；索引里的版本固定到具体提交，因此内容不会随分支漂移。

## 自动收录

索引会自己去找新插件，不需要手工加条目。每天的计划任务先扫一遍 `wanggan768q` 名下所有 `dsh-*` 仓库，再重建索引：

| 触发 | 能发现新仓库 | 说明 |
|---|---|---|
| `schedule`（每天 02:17 UTC） | 是 | 唯一会扫账号仓库的触发，新插件靠它进来 |
| `repository_dispatch`（`upstream-release`） | 否 | 上游发版后主动调用，只同步被点名的那个插件 |
| `workflow_dispatch` | 是（可关） | 手动运行，可选只同步某个插件 |

一轮完整的自动收录做三件事：

1. **发现**（`tools/discover-sources.mjs`）：列出账号下的仓库，把符合条件的写进 `sources.json`。
2. **同步**（`tools/sync-index.mjs`）：克隆这些仓库，按 release tag 往 `index.json` 写版本条目；索引里还没有的插件会按上游 `package.json` 自动建条目，并把上游声明的图标复制进 `icons/`。
3. **校验**（`tools/validate-index.mjs`）：用 DSH 官方 `parseMarketIndex` 验证，外加仓库自身的一致性检查。

只有真的有变化（新插件、新版本、新图标、`sources.json` 变化）才会提交，所以多数运行是空转。

### 仓库被收录的条件

同时满足才会自动加进 `sources.json`：

- 属于 `wanggan768q`，仓库名以 `dsh-` 开头，不是 fork，不是归档，不是本索引仓库自身。
- 默认分支的 `package.json` 里有 `dsh.bundle.patch` —— 没有 bundle 声明的包在 DSH 里根本加载不成插件。
- 至少有一个 SemVer 标签。没有标签的仓库收进索引也永远产不出 `versions[]`，只会让校验失败，所以先跳过、等它发版。

已有的条目不会被改写，手工调整过的 `sources.json` 保持原样。

发现步骤默认用仓库自带的 `GITHUB_TOKEN`——它能读其它账号下的公开仓库，只是限速比 PAT 松紧不同。`UPSTREAM_TOKEN` 是可选的覆盖项，配了就用它；两个都没有时代码退回匿名请求，仍能工作，但共享 runner 的 IP 可能被别处的任务把匿名配额耗尽。

### 让版本更新立刻生效

定时任务是每天一次。想发版后秒级更新，在上游插件仓库加一个 job：

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

`INDEX_DISPATCH_TOKEN` 是一个对 `dsh-plugin-index` 有 `contents: write` 权限的 fine-grained PAT。没配也照样能用，只是退回每天一次。新仓库的发现走不到这条快路径，仍然只由定时任务负责。

## 目录

```text
index.json                       索引文档（format 1），由 sync 脚本生成版本条目
sources.json                     上游插件清单，discover 自动维护，也可手工添加
icons/                           插件图标，相对 index.json 解析
tools/discover-sources.mjs       扫描账号下的 dsh-* 仓库，补进 sources.json
tools/fetch-sources.mjs          CI 里把上游仓库克隆到本地目录
tools/sync-index.mjs             按上游 release tag 重写 index.json
tools/validate-index.mjs         用 DSH 官方校验器验证 index.json
tools/compare-versions.mjs       SemVer 比较，sync 与 validate 共用
.github/workflows/sync-index.yml
```

## 本地操作

```bash
npm ci                 # 安装校验器
npm run discover       # 扫描账号下的 dsh-* 仓库，补进 sources.json
npm run discover -- --dry-run
npm run sync           # 从 ../<上游目录> 读取 tag 并重写 index.json
npm run sync -- --dry-run
npm run validate       # 用 DSH 的 parseMarketIndex 校验
```

`sync` 默认到本仓库的**上级目录**找上游仓库，即 `E:\Git\dsh-plugin-index` 对应 `E:\Git\dsh-discover-agents`。换个位置时用环境变量：

```bash
DSH_INDEX_SOURCE_ROOT=/path/to/checkouts npm run sync
```

本地想保留工作副本、不让脚本重新克隆，跑 `node tools/fetch-sources.mjs --keep-existing`。

`discover` 读 `GITHUB_TOKEN` 或 `GH_TOKEN`，都没有时退到 `gh auth token`，再没有就匿名请求（速率低，可能扫不完）。工作流里用 `secrets.UPSTREAM_TOKEN`，没配时用自带的 `GITHUB_TOKEN`；凭据被拒（例如只授权了本仓库的 token）时会退回匿名请求再试一次。

### 手工新增一个插件

自动发现不覆盖的情况，例如插件不在 `dsh-*` 命名下，或者仓库还没打标签：

1. 在 `sources.json` 加一条：`"<npm 包名>": { "url": "<https 仓库地址>", "directory": "<本地目录名>" }`。
2. 跑 `npm run sync`，条目会自动生成；再按需改 `index.json` 里的 `title`、`description`、`metadata`。
3. 跑 `npm run validate`。

## 同步规则

脚本按标签名匹配 SemVer（`v1.2.0` 与 `1.2.0` 都认），并逐条校验后才收录：

- 标签指向的提交必须在 `HEAD` 的历史里，否则跳过 —— 避免索引固定到无法 clone 的 SHA。
- 该提交的 `package.json` 版本必须与标签一致，否则跳过。
- 该提交的 `package.json` 包名必须与索引条目一致，否则跳过 —— 上游改名后，旧标签不会挂到新名字下面。
- 所有有效标签都会被补录，不只是最新一个。
- 只认标签，未打标签的版本一律不收：分支上的版本号可能还在改。
- 自动生成的条目只写版本，人工字段（`title`、`description`、`icon`、`metadata`）之后可以随意改，脚本不会覆盖。

`engines.dsh` 换到另一个 DSH 小版本线时，同步会失败并要求在 `sources.json` 里给该源加 `"allowMajor": true`。这个范围变化应该由人确认，不能被一个 tag 悄悄改掉。

## 格式规则

完整规则见 DSH 文档 `docs/user/guide/plugin-market.zh.md` 的「索引格式参考」。几条容易踩的：

- `format` 必须是 `1`；`title` 必须有 `en` 键。
- `name` 是 npm 包名格式，索引内唯一。
- `homepage` 可带 `#readme`；`repository.url` 与 Git 来源的 `url` 不能带查询串或片段。
- Git 来源的 `commit` 必须是 40 位小写十六进制 SHA，`path` 是仓库内相对目录。
- `icons/` 图标按索引 URL 相对解析；指向其他源的绝对图标必须用 `https:`。
- `metadata` 里的 `category`、`labels`、`sortKeys` 只能引用根级 `metadata` 声明过的 id。
- `plugins[].versions` 不能为空数组。

## 免责声明

索引内容由本仓库维护，DSH 只校验格式、不验证声明。安装前请核对来源。
