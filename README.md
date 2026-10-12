# dsh-ship-receipt

项目收尾时生成一张**可公开的「交付回执」**：分支与 commit、关键产物的尺寸与 sha256、推送前三步检查的结论、你指定的测试与构建结果——并且把它们硬性分成**已验证 / 仅本地 / 未验证**三区。

A shareable delivery receipt for DeepSeek Harness. It measures what it can, records what it was told, and leaves a blank slot where there is nothing to show.

## 它解决什么

每次收尾都要手写一段汇报：分支、commit、测试过了、构建过了、截图尺寸、密钥扫过了。这段话有两个方向都会出错，而且**两种错在文字里长得一模一样**：

- **写少了漏证据**——"测试通过"没有命令、没有退出码，读者只能信你。
- **写多了越界**——"生产已完整验证"其实只是本地跑通了。

所以这个插件不生成模板，它**测量**：

| | 来源 | 落在哪一区 |
| --- | --- | --- |
| 分支 / commit / 工作区 / 上游对比 | 插件本进程跑只读 git 命令 | **已验证** |
| 关键产物的字节数、sha256、PNG 宽高 | 插件自己读文件算 | **已验证** |
| 推送前三步检查（密钥扫描 / `.gitignore` 核对 / 无关文件清理） | **插件自己跑** | **已验证** |
| 测试与构建 | `checks` 里的命令**默认由插件真的执行**，记录退出码与输出 | **已验证** |
| 你报告但没有自己跑的结果 | `run: false`，附命令与报告值 | **仅本地** |
| 没有任何证据的声明 | `claims` | **未验证** |

## 那条硬规则

**未验证的条目只留标签，正文不显示。**

这不是排版选择。一份措辞自信、背后什么都没有的声明，正是回执要防的东西——而把它染成灰色再照原样印出来，读者照样会把它读成结论。所以 `freezeSection` 会把无证据条目的 `detail` **直接丢掉**，只留下标签和一个显式的空槽：

```
未验证（1）
  生产验证
  ┌────────────────────┐
  │ （没有证据，留空）    │
  └────────────────────┘
```

这条规则在开发中抓到了我自己三处错误——见下面「它抓到过什么」。

## 装

```sh
# npm 版 CLI 管理的 profile
dsh plugin --profile <name> add <插件目录>

# 桌面版：desktop profile 由 Electron app 独占，npm 版 CLI 会被拒绝——
#   error: profile "desktop" is managed exclusively by the Electron application
# 用它自带的那个 CLI 才行（在 app 的 resources/runtime/cli/bin/dsh 下）：
"<app>/resources/runtime/cli/bin/dsh" plugin --profile desktop add <插件目录>
```

装完重启一次 app（host 半区必须重启进程才会加载）。重启后对话视图里会出现「交付回执」Tab，agent 也多了一个 `ship_receipt` 工具。

## 用

```
ship_receipt(
  dir: "D:\\Projects\\my-thing",
  checks: [
    { label: "测试", command: "node --test" },
    { label: "构建", command: "node scripts/build.mjs" },
    { label: "远端 CI", command: "npm test", run: false, exitCode: 0, output: "all green" }
  ],
  artifacts: ["docs/screenshot-1.png"],
  claims: [{ label: "生产验证", statement: "生产环境已完整验证。" }]
)
```

### 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `dir` | ✅ | 要出回执的项目目录 |
| `checks` | | `{label, command, run?}`。**`run` 默认 true，插件真的执行它**并记录退出码、输出、超时。`run: false` 表示只记录你给的 `exitCode` / `output`（那一项就落在**仅本地**） |
| `artifacts` | | 要测量字节数与 sha256 的文件；PNG 会额外读出宽高。声明了但找不到的文件会**单独成一条发现**，不是脚注 |
| `claims` | | 没有证据可引的声明。它们落在**未验证**区，且**正文不会被显示**。不要用它塞结论 |

## 它测量什么，接受什么

**插件自己测的**（因此是已验证）：
- 分支、commit、提交信息、工作区是否干净、`origin`、与上游的领先/落后
- 每个产物的字节数、sha256 前 16 位、PNG 尺寸（读 IHDR）
- 密钥扫描：OpenAI 风格 key、GitHub token、AWS access key、私钥文件头、连接串内嵌凭据——只扫 **git 跟踪的文件**，跳过二进制与超过 2MB 的文件
- `.gitignore` 是否存在与规则条数，以及**受管文件里有没有看着像凭据的路径**（`.env` / `*.pem` / `*.key` / `id_rsa` / `credentials`）
- 受管文件里有没有临时文件（`.tmp` / `.bak` / `.orig` / `.log` / `~` / `scratch` / `draft`）或超过 5MB 的大文件

**只读 git 命令 + 你给的命令，不联网、不上传。**

**插件只能接受报告的**（因此最多是仅本地）：任何它没有自己执行的东西——别的机器上跑的结果、CI 的状态、生产环境的观察。

## 一个刻意的安全取舍

`checks` 里的命令**默认会被真的执行**，用你当前用户的权限。理由：这正是这个插件的价值所在——「测试通过」只有附上插件自己跑出来的退出码才进得了已验证区。

**逐项可以用 `run: false` 关掉。** 工具描述里也写明了默认行为，模型看得到。它执行的命令和 agent 自己本来就能执行的命令是同一批，区别只在于**回执记的是原始结果而不是转述**。

不联网、不上传、不写项目目录（产物写在 `$DSH_HOME/ship-receipt/`）。

## 它抓到过什么

那条「无证据就丢正文」的规则，在开发过程中抓到了我自己写下的三处错误：

1. **`push` 那一节**写成了「还有 N 个 commit 没有推送」却**没带证据**——规则把正文剥掉了，读者只会看到一个空槽。但这件事本来就是 `git rev-list` 量出来的，所以正确的修法是**把测量结果附上去**（现在它是已验证，带上游名和未推送数量），而不是绕过规则。
2. **「这个目录不是 git 仓库」**同样没带证据。它其实是 `git rev-parse` 非零退出的**测量结果**，现在带着那条失败的命令进已验证区。
3. **「声明了检查但没给命令」**的 explanation 原本放在 `detail`（会被剥掉），现在放在 `missing`——因为空槽渲染的是 `missing`。

三个都不是测试写错，是插件按规则拒绝了它渲染不出来的东西。

## 和现有实现的关系

**没有参考任何现有实现的代码。** 这条设想的证据来源是 `2008924/dsh-progress-viz`，另外两条候选里还有 `133563825as-ai/dsh-api-dashboard`。我读了它们的 README 来确认缺口是否真实存在：

- `dsh-progress-viz`（MIT，0 star）：**独立 Python 看板**，解压本地 `session.jsonl.zstd` 事件流，实时显示阶段进度、ETA 与活动流。给自己看的。
- `dsh-api-dashboard`（MIT，16 star）：在输入框下方和看板里显示**自己的** API 余额与用量。也是给自己看的。

两个都是**面向自己的实时面板**；「拿出去给人看、且自带证据分区」的交付回执在生态里确实没有。它们的实现我一行都没看——本插件是独立写的，没有 fork 任何人。

## HTTP 面

```
GET /dsh-ship-receipt               统计、最近一次回执、历史
GET /dsh-ship-receipt/view/<id>     自包含回执页
GET /dsh-ship-receipt/receipt/<id>  回执 JSON
```

## 数据落在哪

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/ship-receipt/runs/<id>/index.html` | 自包含回执页，可归档、可转发 |
| `$DSH_HOME/ship-receipt/runs/<id>/receipt.json` | 回执 JSON |

页面是自包含的（无外部资源、无相对路径），因为它生来就是要发给别人的：不该依赖某个服务器还在、某个资产目录还在。

## 容错姿态

- **`webServer.register` 失败**只是没有页面和 Tab，`ship_receipt` 工具照常工作。
- **git 不可用或目录不是仓库**不是错误：它被记成一条测量结果，回执照样出。
- **`ctx.fs` 存在时优先走它**读文件；只有宿主根本没有 fs 服务时才退回 `node:fs`，并且两条路都有大小上限。
- **读不到某个产物**只影响那一条，进「声明了但找不到的产物」。
- **命令超时**（默认 180 秒）记为超时被杀并保留已捕获的输出。
- **同一仓库并发出回执会被串行化**（`isConcurrencySafe` 返回 false），因为它们会抢同一次测试运行和同一个产物目录。
- **每次注册都可撤销**（`ctx.effect`）。

## 配置

`apply(ctx, config)` 的 config 全部可覆盖：

| key | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/ship-receipt` | 回执产物落在哪 |
| `timeoutMs` | `180000` | 单条 `checks` 命令的超时 |
| `maxFileBytes` | `8MB` | 读单个产物文件的上限 |

## 开发

```sh
node --test          # 41 个测试
node scripts/build.mjs
```

`test/receipt.test.mjs` 里的核心断言是**「被丢掉的那句话在页面和摘要里都不出现」**——因为把句子留在灰色徽章旁边，读者照样会把它当结论读。分区规则由证据决定，不由措辞的自信程度决定，这条规则值得一个会大声失败的测试。

`test/host.test.mjs` 在**真实的临时 git 仓库**上跑工具：真的 commit、真的植入一个密钥看扫描是否能抓到、真的跑一条退出码非零的命令、真的验证未推送的 commit 会被单独点出来。

## License

MIT
