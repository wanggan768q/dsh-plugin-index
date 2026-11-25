# dsh-plugin-index

DeepSeek Harness 的插件市场索引（format 1）。

索引地址：

```text
https://wanggan768q.github.io/dsh-plugin-index/index.json
```

在 DSH 中打开 **插件** → 打开实验性的 **自定义插件索引** → **发现** → **添加索引源**，粘贴上面的地址。

## 收录的插件

表格由 `npm run render-readme` 根据 `index.json` 自动生成，展示各插件已收录的最高 SemVer 版本（可能包含预发布版本）；添加和同步工作流都会更新它，请勿手动修改标记区块。

<!-- plugin-table:start -->
| 插件 | 版本 | 来源 |
|---|---|---|
| `dsh-discover-agents` — 工作区 Agent 发现 | 1.3.0 | [wanggan768q/dsh-discover-agents](https://github.com/wanggan768q/dsh-discover-agents) @ `186386d26d2750ab21b39740f936d5a3567a7afb` |
| `dsh-image-gen` — 图像工坊 | 0.12.3 | npm：`dsh-image-gen`；[源码](https://github.com/shanliuling/dsh-image-gen) |
| `dsh-next-step-suggestion` | 0.3.1 | [Panmax/dsh-next-step-suggestion](https://github.com/Panmax/dsh-next-step-suggestion) @ `f16ad4b0a9277efbc6958e57861f655e9164d327` |
<!-- plugin-table:end -->

`dsh-discover-agents` 未发布到 npm，只能从 Git 提交安装；索引里的版本固定到具体提交，因此内容不会随分支漂移。

`dsh-image-gen` 走 npm 源：它的仓库 `.gitignore` 掉 `lib/`，Git 安装要现场构建，`pnpm` 默认又会拒绝执行 Git 依赖的 prepare 脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），所以索引指向 npm 上已经构建好的发布版本。

## 触发一次添加

`Add a plugin` 工作流（`.github/workflows/add-plugin.yml`）负责收录一个指定插件：检查、写入 `sources.json`、重建 `index.json`、校验、提交，全程一次跑完。适合不在 `wanggan768q` 名下、或者名字不以 `dsh-` 开头的插件 —— 自动发现够不到这些。

在 **Actions** → **Add a plugin** → **Run workflow** 里填表：

| 字段 | 说明 |
|---|---|
| `repository` | 必填，`https://github.com/<owner>/<repo>` 或 `<owner>/<repo>` |
| `source` | `git`（默认，按 release tag 收录）或 `npm`（按 registry 上的发布版本收录） |
| `name` | 索引里的包名；留空用上游 `package.json` 的 `name` |
| `directory` | git 源的本地克隆目录；留空用仓库名 |
| `allow_major` | `engines.dsh` 换到另一个 DSH 小版本线时才需要勾 |
| `dry_run` | 只检查、重建，不提交 |

也可以让插件仓库自己调用，免去在索引仓库里手填：

```yaml
- name: Ask the plugin index to list us
  env:
    INDEX_TOKEN: ${{ secrets.INDEX_DISPATCH_TOKEN }}
  run: |
    curl -fsSL -X POST \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${INDEX_TOKEN}" \
      https://api.github.com/repos/wanggan768q/dsh-plugin-index/dispatches \
      -d '{"event_type":"add-plugin","client_payload":{"repository":"https://github.com/shanliuling/dsh-image-gen","source":"npm"}}'
```

`client_payload` 的字段名与上表一致。`INDEX_DISPATCH_TOKEN` 同样是对 `dsh-plugin-index` 有 `contents: write` 的 fine-grained PAT。

请求不合法时工作流在写文件之前就失败，仓库保持原样。检查项：

- 仓库存在、公开、未归档。
- 默认分支的 `package.json` 有 `dsh.bundle.patch` —— 没有 bundle 声明的包在 DSH 里加载不成插件。
- 包名是合法的 npm 名，且没被别的 URL 占用。
- 源至少能产出一个版本：git 源要有 SemVer 标签，npm 源要在 registry 上有发布版本。

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
tools/add-source.mjs             收录一个指定插件仓库
tools/discover-sources.mjs       扫描账号下的 dsh-* 仓库，补进 sources.json
tools/fetch-sources.mjs          CI 里把上游仓库克隆到本地目录
tools/github-api.mjs             add 与 discover 共用的 GitHub/registry 辅助函数
tools/sync-index.mjs             按上游 release tag 或 npm 发布版本重写 index.json
tools/validate-index.mjs         用 DSH 官方校验器验证 index.json
tools/compare-versions.mjs       SemVer 比较，sync 与 validate 共用
.github/workflows/add-plugin.yml      收录一个指定插件
.github/workflows/sync-index.yml      定时发现与版本同步
```

## 本地操作

```bash
npm ci                 # 安装校验器
npm run add <repo>     # 收录一个指定插件，例如 npm run add -- shanliuling/dsh-image-gen --source npm
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

自动发现够不到的情况，例如插件不在 `dsh-*` 命名下、属于别人、或者仓库还没打标签，有三条路：

1. **在 Actions 里跑 `Add a plugin`** —— 填仓库地址即可，检查、收录、校验、提交一次完成。推荐。
2. **本地跑 `npm run add`** —— 与工作流同一个脚本，先看结果再提交：
   ```bash
   npm run add -- shanliuling/dsh-image-gen --source npm --dry-run
   npm run add -- shanliuling/dsh-image-gen --source npm
   ```
3. **直接改 `sources.json`** —— `"<npm 包名>": { "url": "<https 仓库地址>", "directory": "<本地目录名>" }`，npm 源把 `directory` 换成 `"source": "npm"`。之后跑 `npm run sync`，条目会自动生成，再按需改 `index.json` 里的 `title`、`description`、`metadata`，最后 `npm run validate`。

## 同步规则

脚本按两种源分别取版本：

- **git 源**：按标签名匹配 SemVer（`v1.2.0` 与 `1.2.0` 都认），逐条校验后才收录。
  - 标签指向的提交必须在 `HEAD` 的历史里，否则跳过 —— 避免索引固定到无法 clone 的 SHA。
  - 该提交的 `package.json` 版本必须与标签一致，否则跳过。
  - 该提交的 `package.json` 包名必须与索引条目一致，否则跳过 —— 上游改名后，旧标签不会挂到新名字下面。
  - 所有有效标签都会被补录，不只是最新一个。
  - 只认标签，未打标签的版本一律不收：分支上的版本号可能还在改。
- **npm 源**：以 registry 的 packument 为准，收录它列出的每一个版本（不只是 `dist-tags.latest`），`publishTimestamp` 取 registry 的发布时间。npm 上有、Git 里没打 tag 的版本照样进来，反过来只在 Git 打 tag 而没发布 npm 的版本进不来。

自动生成的条目只写版本，人工字段（`title`、`description`、`icon`、`metadata`）之后可以随意改，脚本不会覆盖。

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
