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
| `@local/dsh-discover-agents` — 工作区 Agent 发现 | 1.1.0 | [wanggan768q/dsh-discover-agents](https://github.com/wanggan768q/dsh-discover-agents) @ `53aae3b6547e6e6b54d8b6e0702f6ae85d79274f` |

该插件未发布到 npm，只能从 Git 提交安装；索引里的版本固定到具体提交，因此内容不会随分支漂移。

## 目录

```text
index.json                     索引文档（format 1）
icons/                         插件图标，相对 index.json 解析
```

## 更新一个版本

1. 在上游仓库打 tag 并推送提交。
2. 取该提交的完整 40 位 SHA：`git -C <上游仓库> rev-parse HEAD`。
3. 在 `index.json` 的 `plugins[].versions` 里新增一条，字段为 `version`、`publishTimestamp`（Unix 秒）、`source`、`engines.dsh`。校验器会按 SemVer 降序重排，可以不按顺序写。
4. 预览站点的校验：发布后用 DSH 的「发现」页添加索引源，或本地跑 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex`。

## 格式规则

完整规则见 DSH 文档 `docs/user/guide/plugin-market.zh.md` 的「索引格式参考」。几条容易踩的：

- `format` 必须是 `1`；`title` 必须有 `en` 键。
- `name` 是 npm 包名格式，索引内唯一。
- `homepage` 可带 `#readme`；`repository.url` 与 Git 来源的 `url` 不能带查询串或片段。
- Git 来源的 `commit` 必须是 40 位小写十六进制 SHA，`path` 是仓库内相对目录。
- `icons/` 图标按索引 URL 相对解析；指向其他源的绝对图标必须用 `https:`。

## 免责声明

索引内容由本仓库维护，DSH 只校验格式、不验证声明。安装前请核对来源。
