# Changelog

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：写清 `checks` 里的命令由插件真的执行（`exec`，180 秒超时、
  4000 字符输出截断）、读哪些文件、回执写到 `$DSH_HOME/ship-receipt/runs/`、路由没有
  自己的 token、以及密钥扫描只是 5 条正则等已知限制。
- 新增 `.github/workflows/ci.yml`：ubuntu + windows × node 22/24，构建后断言 `lib/`
  与 `src/` 一致，再跑 `npm test`。
- README 顶部加 CI 与 license badge，引言后加一句 star 引导。没有加 npm badge——这个包
  没有发布到 npm。

## 0.1.0

- `ship_receipt` tool: produces a shareable delivery receipt for a project
  directory, hard-split into 已验证 / 仅本地 / 未验证 by evidence rather than by
  wording.
- Measured by the plugin itself, so it lands in 已验证: branch, commit, subject,
  dirty state, origin, ahead/behind against upstream, artifact byte counts and
  sha256 (PNG dimensions read from the IHDR), the secret scan, the `.gitignore`
  review, and the unrelated/temp-file cleanup — the three mandated pre-push
  checks.
- `checks` commands are executed by the plugin by default (`run: false` opts out),
  recording exit code, output and timeout, so "the tests pass" can be a
  measurement instead of a claim.
- `claims` with no evidence are rendered as an explicit blank slot: the section
  keeps its label and loses its prose, because a confident sentence beside a grey
  badge is still read as a conclusion.
- Self-contained HTML receipt plus a JSON twin, served over
  `/dsh-ship-receipt/view/<id>` and `/dsh-ship-receipt/receipt/<id>`.
- 交付回执 Tab rendering the same three zones the host computed.
- Read-only git commands only; no network, no upload; the receipt is written
  outside the project directory.
