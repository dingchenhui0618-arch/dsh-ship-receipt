# 安全模型 / Security model

这份文档说明 **dsh-ship-receipt** 信任什么、接受什么输入、会在这台机器上执行什么、把
结果写到哪里。它从实现（`src/host.js`、`src/receipt.js`、`src/client.cjs`）里读出来；
**如果文档和代码不一致，以代码为准，那说明这份文档是个 bug。**

> 一句话：这个插件会**真的执行模型给它的命令**——`checks` 里的每一条默认都在你的项目
> 目录里跑一遍（`exec`，超时 180 秒）。它生成的回执里没有问题单，但这不代表它只读。

## 信任边界

插件跑在 DSH 的宿主进程里，注入 `webServer` 和 `tools`（`src/host.js` 的 `inject`）。
它对外只有两个表面：

| 表面 | 谁能触发 | 这一层有没有鉴权 |
| --- | --- | --- |
| `ship_receipt` 工具 | 任何能驱动模型的会话/子代理 | 没有独立鉴权，和 DSH 里其他工具一样，靠宿主自己的权限策略 |
| 回环路由 `/dsh-ship-receipt`（`ctx.webServer.register`，`kind: 'prefix'`） | 能访问 DSH web server 的人 | **没有自己的 token**；边界是宿主 web server 的监听地址与鉴权 |
| 子进程（`node:child_process.exec`） | 由工具参数决定 | 继承本进程的完整用户权限，没有沙箱 |

**视为不可信输入的**：

- **模型给的 `checks[].command`**——它被 `exec(command, { cwd: root, timeout })` 直接交给
  shell，`run: false` 只是"不执行"，不是"不能执行"；
- **模型给的 `dir`、`artifacts[]`**——`dir` 相对当前工作目录解析，`artifacts` 里写绝对路径
  就按绝对路径读（`readBytes`）；
- **路由上的 `id`**——`/view/<id>`、`/receipt/<id>` 的 id 由 `safeName` 过滤
  （必须等于 `basename`，且不含 `..`），否则 404；
- **回执里的所有文本**——项目名、命令输出、测试输出、调用方声明的 `claims`，都当作要
  转义的字符串处理，不当作 HTML。

## 它真的执行命令（最重要的一条）

`runReceipt` 对每个 `checks` 条目调用 `run(command, root, timeoutMs)`：

- `exec` 走系统 shell，所以 `&&`、`|`、重定向、`$(...)` 都成立；
- 默认超时 180 秒（`DEFAULT_TIMEOUT_MS`，配置项 `timeoutMs`），超时会终止子进程；
- 标准输出与错误输出合并后**只保留前 4000 字符**（`MAX_OUTPUT_CHARS`）写进回执，
  缓冲上限 8 MiB，超出部分被丢弃；
- 命令的退出码被记录，非零不是异常，而是回执里"这一项没有通过"的证据。

也就是说：**给这个工具一个 `checks` 数组，等于在你的项目目录里跑一组 shell 命令。**
它的价值（"测试通过"成为可验证的测量）和它的风险是同一件事。不要在不可信的会话里
让它跑你没有看过的命令。

## 它读什么

- 读**只读 git 命令**：`rev-parse`、`log -1`、`status --porcelain`、`remote get-url`、
  `rev-list --left-right --count`、`ls-files`；
- 读 `artifacts` 里点名的文件（默认上限 8 MiB/个，`maxFileBytes`），记录字节数、
  sha256 前 16 位、PNG 的 IHDR 宽高——**不把文件内容写进回执**；
- 读 `.gitignore` 规则条数；
- 读 git 跟踪的文件做密钥扫描（`git ls-files`；不是 git 仓库时退化为遍历目录，最多
  400 个文件，跳过 `.git`、`node_modules`、`dist`、`build`、`.next`、`coverage`）；
- 扫描时**只记录文件名与命中的规则名**（例如"GitHub token"），**不记录命中的密钥本身**；
  超过 2 MiB 的文件和含 NUL 的二进制文件跳过。

## 它写什么

只写自己的数据目录，**不碰被检查项目的文件**：

```
$DSH_HOME/ship-receipt/runs/<时间戳>-<序号>/index.html   # 自包含 HTML 回执
$DSH_HOME/ship-receipt/runs/<时间戳>-<序号>/receipt.json # 同一份内容的 JSON
```

- 目录可用 `dataDir` 配置；默认 `<DSH_HOME>/ship-receipt`，`DSH_HOME` 缺省 `~/.dsh`；
- 已经有 30 份时**不删除旧文件**，内存里的历史只保留 30 条；
- 没有清理命令、没有上传、没有遥测；`src/` 里没有任何 `fetch`/`http` 调用。

## 路由与页面

- `GET /dsh-ship-receipt` 返回 `stats`、最近 12 条历史、**最新一份完整回执**、以及配置
  （含 `dataDir` 绝对路径和超时值）；
- `GET /dsh-ship-receipt/view/<id>` 返回 `index.html`，`GET .../receipt/<id>` 返回 JSON；
- 其它方法/路径一律 404；请求体上限 1 MiB，超了 `req.destroy()`；
- 页面是自包含的（内联 CSS，没有外链），所有插入点都走 `escapeHtml`
  （`& < > " '` 五个字符），没有任何 `innerHTML` / `dangerouslySetInnerHTML`。

**这些页面里会有本机绝对路径、git remote、命令输出**——命令输出可能包含测试打印的
临时凭据或内部地址。路由本身不做额外鉴权，所以"谁能访问 DSH web server"就等于
"谁能看这些回执"。

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **任意命令执行**：见上。没有命令白名单、没有 shell 禁用、没有 sandbox。唯一的上限
   是超时和输出截断。
2. **密钥扫描是正则，不是保险**：只覆盖 5 类（OpenAI 风格 key、GitHub token、AWS access
   key、私钥文件头、带凭据的连接串）。它只扫 git 跟踪的文件；`.gitignore` 忽略掉的文件、
   超过 2 MiB 的文件、二进制文件都不会被扫到。漏报是正常的，命中才值得停下来。
3. **不检查 `.gitignore` 是否"够用"**：它只数规则条数、列出"看起来像凭据"的受管路径
   （`.env`、`.pem`、`.key`、`id_rsa`、`credentials`），不判断规则是否真的覆盖了这些文件。
4. **临时文件/大文件检查只针对受管文件**：`TEMP_NAME` 是文件名启发式（`.tmp`、`.bak`、
   `.log`、`scratch`、`draft` 等），超过 5 MiB 才叫大文件。这是提醒，不是门禁。
5. **输出只留开头 4000 字符**：一条失败命令如果把原因写在末尾，回执里看不到。这是为了
   防止一份回执把整个测试日志吞进去。
6. **回执是 HTML，不是签名文件**：sha256 只算前 16 位十六进制（`slice(0, 16)`），足够
   比对同一份文件，不足以当内容凭证。
7. **并发不安全**：工具声明 `isConcurrencySafe: false`；同一目录两次回执会跑两遍相同的
   测试命令，并各自落一个目录。
8. **状态在内存**：`stats` 与最近 12 条历史随宿主进程重启清空；磁盘上的 run 目录还在，
   但只有 `latest` 和当前进程写过的才会出现在 `/dsh-ship-receipt` 的响应里。

## 明确不算漏洞的

- **回执页面能被人从别的设备打开**：那是宿主 web server 的暴露面，不是本插件的；
- **`checks` 跑的命令改了工作区**：命令是你/模型给的，插件只负责执行和记录，不替它
  承诺副作用为零；
- **`artifacts` 指向任意绝对路径**：设计上允许点任何文件来量尺寸与哈希；它只读元数据，
  不复制内容（但"文件存在且多大"本身是一个可观察的事实）；
- **密钥扫描没扫出 `.gitignore` 里的 `.env`**：见限制 2；
- **回执里的文本导致 XSS**：所有插入点都转义，客户端用 `React.createElement`，没有
  `innerHTML`。

## 报告漏洞

用 GitHub 的私密渠道：
<https://github.com/dingchenhui0618-arch/dsh-ship-receipt/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但我会读、会修，修完会在 CHANGELOG 里写清影响
范围与修复版本。请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护最新一版（当前 `0.1.x`，见 `package.json`）。更早的版本不回补；升级到最新版即可。
这个包**没有发布到 npm**（`npm view dsh-ship-receipt version` 不存在），所以没有 npm
渠道的旧版本需要担心。
