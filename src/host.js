// Host half of dsh-ship-receipt.
//
// One tool, `ship_receipt`, and a route serving what it produced. The tool's job
// is to MEASURE, not to transcribe: git state, file hashes and sizes, PNG
// dimensions, a secret scan, the three pre-push checks, and — when asked — the
// test and build commands themselves. Anything that was measured lands in
// 已验证; anything merely reported lands in 仅本地; anything with nothing behind
// it lands in 未验证 with its prose removed.
//
// That last behaviour is why this cannot be a template. A template renders what
// it is given. This refuses to render a claim it cannot support.

import { createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { buildReceipt, renderReceipt, summarise } from './receipt.js'

export const name = 'dsh-ship-receipt'
// `tools` is a hard dependency even though the tool is the only thing this
// plugin adds: cordis refuses `ctx.tools` unless it was injected, and the first
// build of this plugin shipped with only `webServer` declared and failed to
// activate with "cannot get property \"tools\" without inject".
export const inject = ['webServer', 'tools']

const ROUTE = '/dsh-ship-receipt'
const DEFAULT_TIMEOUT_MS = 180000
const MAX_OUTPUT_CHARS = 4000
const BIG_FILE_BYTES = 5 * 1024 * 1024

// The same families the user's own pre-push step names. Kept deliberately small
// and specific: a scanner that shouts at ordinary code gets ignored, and an
// ignored scanner is worse than none.
const SECRET_PATTERNS = [
  { label: 'OpenAI 风格 key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { label: '私钥文件头', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: '连接串内嵌凭据', re: /:\/\/[^/\s:@]+:[^/\s@]{6,}@/ },
]

const IGNORE_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage'])
const TEMP_NAME = /(\.tmp$|\.bak$|\.orig$|\.rej$|\.log$|^~|^\.DS_Store$|scratch|draft)/i
const RISKY_TRACKED = /(^|\/)\.env(\.|$)|\.pem$|\.key$|(^|\/)id_rsa$|credentials/i

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 1048576) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function segmentsOf(url) {
  const path = String(url || '').split('?')[0]
  if (path === ROUTE || path === ROUTE + '/') return []
  // null, not an empty list: a prefix route can be handed `/dsh-ship-receiptXYZ`
  // on a raw string match, and answering that with the state would make every
  // near-miss look like it worked.
  if (path.indexOf(ROUTE + '/') !== 0) return null
  return path.slice(ROUTE.length + 1).split('/').filter(function (part) { return part.length > 0 })
}

function safeName(value) {
  const text = String(value || '')
  if (text.length === 0) return undefined
  if (text !== basename(text)) return undefined
  if (text.indexOf('..') >= 0) return undefined
  return text
}

function stamp(date) {
  const pad = function (n) { return String(n).padStart(2, '0') }
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

function run(command, cwd, timeoutMs) {
  return new Promise(function (resolve) {
    exec(command, { cwd: cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, function (error, stdout, stderr) {
      const out = String(stdout === undefined ? '' : stdout)
      const err = String(stderr === undefined ? '' : stderr)
      const code = error === null || error === undefined
        ? 0
        : (typeof error.code === 'number' ? error.code : 1)
      resolve({
        exitCode: code,
        timedOut: error !== undefined && error !== null && error.killed === true,
        output: (out + (err.length > 0 ? (out.length > 0 ? '\n' : '') + err : '')).slice(0, MAX_OUTPUT_CHARS),
        chars: out.length + err.length,
      })
    })
  })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** PNG dimensions from the IHDR, so a screenshot's size is a measurement. */
function pngSize(bytes) {
  if (bytes.length < 24) return undefined
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== signature[i]) return undefined
  }
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return undefined
  const readU32 = function (at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  }
  return { width: readU32(16), height: readU32(20) }
}

/**
 * @param {object} ctx cordis context
 * @param {{dataDir?:string, timeoutMs?:number, maxFileBytes?:number}} [config]
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.length > 0
    ? settings.dataDir
    : join(dshHome(), 'ship-receipt')
  const runsDir = join(dataDir, 'runs')
  const timeoutMs = Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxFileBytes = Number.isInteger(settings.maxFileBytes) && settings.maxFileBytes > 0
    ? settings.maxFileBytes
    : 8 * 1024 * 1024

  const history = []
  const stats = { runs: 0, failed: 0 }
  let latest
  let sequence = 0

  function nextId() {
    const base = stamp(new Date())
    let id
    do {
      sequence += 1
      id = base + '-' + sequence
    } while (existsSync(join(runsDir, id)))
    return id
  }

  /** Read with the harness's own filesystem service when it is available. */
  async function readBytes(path) {
    const fs = ctx.get('fs')
    if (fs !== undefined) {
      const target = await fs.resolve(path)
      return await fs.readBytes(target, undefined, maxFileBytes)
    }
    const info = statSync(path)
    if (info.size > maxFileBytes) {
      throw new Error('文件超过 ' + maxFileBytes + ' 字节上限：' + path)
    }
    return new Uint8Array(readFileSync(path))
  }

  function walkFiles(root, limit) {
    const found = []
    const stack = [root]
    while (stack.length > 0 && found.length < limit) {
      const current = stack.pop()
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const entry of entries) {
        if (entry.name === '.git' || IGNORE_SKIP.has(entry.name)) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) found.push(full)
        if (found.length >= limit) break
      }
    }
    return found
  }

  async function collectGit(dir) {
    const git = async function (command) { return run(command, dir, 30000) }
    const branch = await git('git rev-parse --abbrev-ref HEAD')
    if (branch.exitCode !== 0) return undefined
    const commit = await git('git rev-parse HEAD')
    const subject = await git('git log -1 --pretty=%s')
    const status = await git('git status --porcelain')
    const remote = await git('git remote get-url origin')
    const upstream = await git('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}')
    const comparison = upstream.exitCode === 0
      ? await git('git rev-list --left-right --count @{upstream}...HEAD')
      : undefined

    let ahead
    let behind
    if (comparison !== undefined && comparison.exitCode === 0) {
      const parts = comparison.output.trim().split(/\s+/)
      behind = Number(parts[0])
      ahead = Number(parts[1])
    }

    return {
      branch: branch.output.trim(),
      commit: commit.output.trim(),
      subject: subject.output.trim(),
      dirty: status.output.trim().length === 0 ? 0 : status.output.trim().split('\n').length,
      remote: remote.exitCode === 0 ? remote.output.trim() : '',
      upstream: upstream.exitCode === 0 ? upstream.output.trim() : '',
      ahead: Number.isFinite(ahead) ? ahead : undefined,
      behind: Number.isFinite(behind) ? behind : undefined,
      tracked: status.exitCode === 0,
    }
  }

  async function collectTracked(dir) {
    const result = await run('git ls-files', dir, 30000)
    if (result.exitCode !== 0) return []
    return result.output.split('\n').map(function (line) { return line.trim() }).filter(function (line) { return line.length > 0 })
  }

  function secretScan(root, files) {
    const hits = []
    let scanned = 0
    let unreadable = 0
    for (const relative of files) {
      const full = join(root, relative)
      let info
      try {
        info = statSync(full)
      } catch (error) {
        unreadable += 1
        continue
      }
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch (error) {
        unreadable += 1
        continue
      }
      scanned += 1
      if (text.indexOf('\u0000') >= 0) continue
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) hits.push({ file: relative, kind: pattern.label })
      }
    }
    return { scanned: scanned, unreadable: unreadable, files: files.length, hits: hits }
  }

  function ignoreReview(root, files) {
    const path = join(root, '.gitignore')
    if (!existsSync(path)) {
      return { exists: false, rules: 0, risky: files.filter(function (f) { return RISKY_TRACKED.test(f) }) }
    }
    const text = readFileSync(path, 'utf8')
    const rules = text.split('\n').map(function (line) { return line.trim() })
      .filter(function (line) { return line.length > 0 && line.charAt(0) !== '#' })
    return {
      exists: true,
      rules: rules.length,
      risky: files.filter(function (f) { return RISKY_TRACKED.test(f) }),
    }
  }

  function cleanupReview(root, files) {
    const temp = []
    const big = []
    for (const relative of files) {
      if (TEMP_NAME.test(relative)) temp.push(relative)
      try {
        const info = statSync(join(root, relative))
        if (info.size > BIG_FILE_BYTES) big.push({ file: relative, bytes: info.size })
      } catch (error) {
        // A file that vanished between listing and measuring is not a finding.
      }
    }
    return { temp: temp, big: big }
  }

  async function runReceipt(args) {
    const dir = String(args.dir === undefined || args.dir === null ? '' : args.dir).trim()
    if (dir.length === 0) throw new Error('缺少 dir：请给出要出回执的项目目录。')
    const root = isAbsolute(dir) ? dir : resolvePath(process.cwd(), dir)
    if (!existsSync(root)) throw new Error('目录不存在：' + root)

    const sections = []
    const notes = []

    // --- measured: git -------------------------------------------------------
    const git = await collectGit(root)
    if (git === undefined) {
      // Measured, not missing: the plugin ran git and it said no. Saying "not a
      // repository" with the failing command behind it is a measurement, and
      // leaving the evidence out would have made the rule strip the sentence.
      sections.push({
        id: 'git',
        label: 'git 状态（分支 / commit / 工作区）',
        measured: true,
        detail: '这个目录不是一个 git 仓库，所以没有分支 / commit 可报。',
        evidence: [
          { label: '命令', value: 'git rev-parse --abbrev-ref HEAD' },
          { label: '结果', value: '非零退出，目录不是仓库或 git 不可用' },
        ],
      })
    } else {
      const evidence = [
        { label: '分支', value: git.branch },
        { label: 'commit', value: git.commit },
        { label: '提交信息', value: git.subject },
        { label: '工作区', value: git.dirty === 0 ? '干净（没有未提交改动）' : git.dirty + ' 个文件有改动' },
      ]
      if (git.remote.length > 0) evidence.push({ label: 'origin', value: git.remote })
      if (git.upstream.length > 0) {
        evidence.push({
          label: '与上游',
          value: (git.ahead === undefined ? '?' : git.ahead) + ' 个未推送 / ' + (git.behind === undefined ? '?' : git.behind) + ' 个未拉取',
        })
      }
      sections.push({
        id: 'git',
        label: 'git 状态（分支 / commit / 工作区）',
        measured: true,
        detail: git.dirty === 0 ? '工作区干净。' : '工作区有未提交改动，回执里的 commit 不是当前全部内容。',
        evidence: evidence,
      })
      if (git.ahead !== undefined && git.ahead > 0) {
        // Measured by git and therefore verified. Writing this as a bare warning
        // was the first version, and the zoning rule correctly stripped its text
        // for having no evidence — so the fix is to attach the measurement.
        sections.push({
          id: 'push',
          label: 'commit 是否已经推到远端',
          measured: true,
          detail: '还有 ' + git.ahead + ' 个 commit 没有推送，远端看到的不是这个版本。',
          evidence: [
            { label: '上游', value: git.upstream },
            { label: '未推送', value: git.ahead + ' 个 commit' },
          ],
        })
      }
    }

    // --- measured: artifacts -------------------------------------------------
    const artifactPaths = Array.isArray(args.artifacts) ? args.artifacts : []
    if (artifactPaths.length > 0) {
      const evidence = []
      const missing = []
      for (const raw of artifactPaths) {
        const relative = String(raw)
        const full = isAbsolute(relative) ? relative : join(root, relative)
        if (!existsSync(full)) {
          missing.push(relative + '（不存在）')
          continue
        }
        let bytes
        try {
          bytes = await readBytes(full)
        } catch (error) {
          missing.push(relative + '（读不到：' + String((error && error.message) || error) + '）')
          continue
        }
        const size = pngSize(bytes)
        evidence.push({
          label: relative,
          value: bytes.length + ' 字节 · sha256 ' + sha256(bytes).slice(0, 16) + '…' +
            (size === undefined ? '' : ' · ' + size.width + '×' + size.height),
        })
      }
      sections.push({
        id: 'artifacts',
        label: '关键产物的尺寸与哈希',
        measured: true,
        evidence: evidence,
      })
      if (missing.length > 0) {
        // A declared artifact that is not there is a finding, not a footnote.
        sections.push({
          id: 'artifacts-missing',
          label: '声明了但找不到的产物',
          measured: true,
          evidence: missing.map(function (text) { return { label: '缺失', value: text } }),
        })
      }
    }

    // --- measured: the three pre-push checks ---------------------------------
    const tracked = await collectTracked(root)
    const files = tracked.length > 0 ? tracked : walkFiles(root, 400).map(function (full) {
      return full.slice(root.length + 1).split('\\').join('/')
    })

    const secrets = secretScan(root, files)
    sections.push({
      id: 'check-secrets',
      label: '推送前检查 ① 密钥 / token 扫描',
      measured: true,
      detail: secrets.hits.length === 0
        ? '扫描 ' + secrets.scanned + ' 个文件，没有命中。'
        : '命中 ' + secrets.hits.length + ' 处，**不应该推送**。',
      evidence: secrets.hits.length === 0
        ? [{ label: '结论', value: 'clean（扫描 ' + secrets.scanned + ' / 共 ' + secrets.files + ' 个受管文件）' }]
        : secrets.hits.map(function (hit) { return { label: hit.file, value: hit.kind } }),
    })

    const ignore = ignoreReview(root, files)
    sections.push({
      id: 'check-gitignore',
      label: '推送前检查 ② .gitignore 核对',
      measured: true,
      detail: ignore.exists
        ? '有 ' + ignore.rules + ' 条规则，受管文件里有 ' + ignore.risky.length + ' 个看着像凭据的路径。'
        : '没有 .gitignore。',
      evidence: ignore.risky.length > 0
        ? ignore.risky.slice(0, 20).map(function (file) { return { label: '疑似凭据入仓', value: file } })
        : [{ label: '结论', value: (ignore.exists ? ignore.rules + ' 条规则' : '无 .gitignore') + ' · 没有疑似凭据被跟踪' }],
    })

    const cleanup = cleanupReview(root, files)
    sections.push({
      id: 'check-cleanup',
      label: '推送前检查 ③ 无关 / 临时文件清理',
      measured: true,
      detail: cleanup.temp.length === 0 && cleanup.big.length === 0
        ? '受管的 ' + files.length + ' 个文件里没有临时文件、也没有超过 5MB 的大文件。'
        : '临时文件 ' + cleanup.temp.length + ' 个，大文件 ' + cleanup.big.length + ' 个。',
      evidence: cleanup.temp.length === 0 && cleanup.big.length === 0
        ? [{ label: '结论', value: 'clean（' + files.length + ' 个受管文件）' }]
        : cleanup.temp.slice(0, 20).map(function (file) { return { label: '临时文件', value: file } })
          .concat(cleanup.big.slice(0, 20).map(function (item) {
            return { label: '大文件', value: item.file + '（' + item.bytes + ' 字节）' }
          })),
    })

    // --- checks: run here, or taken as reported ------------------------------
    const checks = Array.isArray(args.checks) ? args.checks : []
    for (const raw of checks) {
      const label = String(raw !== undefined && raw !== null && raw.label !== undefined ? raw.label : '检查')
      const command = String(raw !== undefined && raw !== null && raw.command !== undefined ? raw.command : '')
      const shouldRun = raw === undefined || raw === null || raw.run !== false
      if (command.length === 0) {
        // No command means no result to cite. The explanation goes in `missing`
        // rather than `detail`, because `missing` is what an unverified slot
        // actually renders — the rule keeps `detail` stripped, and that is the
        // behaviour this plugin exists to have.
        sections.push({
          id: 'check-' + label,
          label: label,
          measured: false,
          missing: ['声明了检查但没有提供命令，所以没有任何结果可引。'],
        })
        continue
      }
      if (shouldRun) {
        const result = await run(command, root, timeoutMs)
        sections.push({
          id: 'check-' + label,
          label: label,
          measured: true,
          detail: result.exitCode === 0 ? '退出码 0。' : '退出码 ' + result.exitCode + '，**这一项没有通过**。',
          evidence: [
            { label: '命令', value: command },
            { label: '退出码', value: String(result.exitCode) + (result.timedOut ? '（超时被杀）' : '') },
            { label: '输出', value: result.output.length > 0 ? result.output : '（无输出）' },
          ],
        })
      } else {
        sections.push({
          id: 'check-' + label,
          label: label,
          measured: false,
          detail: '由调用方报告，插件没有自己运行。',
          evidence: [
            { label: '命令', value: command },
            { label: '报告的退出码', value: String(raw.exitCode === undefined ? '未提供' : raw.exitCode) },
            { label: '报告的输出', value: String(raw.output === undefined ? '未提供' : raw.output).slice(0, MAX_OUTPUT_CHARS) },
          ],
        })
      }
    }

    // --- claims: no evidence, so no prose ------------------------------------
    const claims = Array.isArray(args.claims) ? args.claims : []
    for (const raw of claims) {
      const label = String(raw !== undefined && raw !== null && raw.label !== undefined ? raw.label : '声明')
      sections.push({
        id: 'claim-' + label,
        label: label,
        measured: false,
        // Deliberately stored, and deliberately stripped by buildReceipt: this
        // is the text a careless receipt would print as if it were a result.
        detail: String(raw !== undefined && raw !== null && raw.statement !== undefined ? raw.statement : ''),
        evidence: Array.isArray(raw === undefined || raw === null ? undefined : raw.evidence) ? raw.evidence : [],
      })
    }

    const receipt = buildReceipt({
      generatedAt: new Date().toISOString(),
      project: { dir: root, name: basename(root) },
      sections: sections,
      footer: '分区由证据决定：已验证＝插件本进程刚测到，仅本地＝本机观察到的，未验证＝没有证据、只留标签。',
    })

    const id = nextId()
    const dirOut = join(runsDir, id)
    mkdirSync(dirOut, { recursive: true })
    const pagePath = join(dirOut, 'index.html')
    const jsonPath = join(dirOut, 'receipt.json')
    writeFileSync(pagePath, renderReceipt(receipt), 'utf8')
    writeFileSync(jsonPath, JSON.stringify(receipt, null, 2), 'utf8')

    const entry = {
      id: id,
      at: receipt.generatedAt,
      project: receipt.project,
      counts: receipt.counts,
      dir: dirOut,
      page: ROUTE + '/view/' + id,
      json: ROUTE + '/receipt/' + id,
    }
    history.push(entry)
    while (history.length > 30) history.shift()
    latest = Object.assign({}, entry, { receipt: receipt })
    stats.runs += 1

    return { receipt: receipt, id: id, page: entry.page, dir: dirOut, html: pagePath, json: jsonPath, notes: notes }
  }

  ctx.effect(function () {
    return ctx.tools.register({
      name: 'ship_receipt',
      description: [
        '项目收尾时生成一张可公开的「交付回执」：分支与 commit、工作区状态、关键产物的尺寸与 sha256、',
        '推送前三步检查（密钥扫描 / .gitignore 核对 / 无关文件清理）的结论，以及你指定的测试与构建结果。',
        '内容被硬性分成三区——**已验证**（本插件刚刚自己测出来的）、**仅本地**（本机观察到的、带命令与退出码）、',
        '**未验证**（没有任何证据，只留标签，不补话）。所以「测试通过」这类话必须附上命令和退出码才进得了前两区。',
        '`checks` 里的命令默认**由本插件真的执行**（`run: false` 可改为只记录你报告的结果）；',
        '`claims` 是无证据的声明，会落在未验证区且正文不会显示。生成一份自包含 HTML 与一份 JSON。',
        '只读 git 命令 + 你给的命令，不联网、不上传。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '要出回执的项目目录（绝对路径，或相对当前工作目录）。' },
          checks: {
            type: 'array',
            description: '要执行并记录的命令，例如 {label:"测试", command:"node --test"}。默认由插件执行；run:false 表示只记录调用方报告的结果。',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                command: { type: 'string' },
                run: { type: 'boolean', description: '默认 true。false 表示插件不执行，只记录你给的 exitCode/output。' },
                exitCode: { type: 'integer' },
                output: { type: 'string' },
              },
              required: ['label'],
            },
          },
          artifacts: {
            type: 'array',
            description: '要测量尺寸与 sha256 的文件，例如截图。PNG 会额外读出宽高。',
            items: { type: 'string' },
          },
          claims: {
            type: 'array',
            description: '没有证据可引的声明。它们会落在「未验证」区，且**正文不会被显示**——只留标签。不要用它来塞结论。',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, statement: { type: 'string' } },
              required: ['label'],
            },
          },
        },
        required: ['dir'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', description: '三分区的交付回执，含每条的区、证据与缺少的证据。' },
        render: function (args, value) {
          const receipt = value !== undefined && value !== null && value.receipt !== undefined ? value.receipt : value
          const page = value !== undefined && value !== null ? value.page : undefined
          const text = summarise(receipt)
          return [{ type: 'text', text: page === undefined ? text : text + '\n\n回执页面：' + page }]
        },
      },
      // Two receipts in one repo would race on the same test run and the same
      // run directory, so this one does not pretend to be parallel-safe.
      isConcurrencySafe: function () { return false },
      presentCall: function (args) {
        const dir = args !== undefined && args !== null ? args.dir : undefined
        return {
          card: 'generic',
          title: 'ship_receipt',
          kind: 'read',
          rawInput: args,
          locations: typeof dir === 'string' ? [{ path: dir }] : undefined,
        }
      },
      execute: async function (args) {
        const safe = args !== undefined && args !== null && typeof args === 'object' ? args : {}
        try {
          return await runReceipt(safe)
        } catch (error) {
          stats.failed += 1
          throw new Error('[dsh-ship-receipt] ' + String((error && error.message) || error))
        }
      },
    })
  })

  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async function (req, res) {
          try {
            const parts = segmentsOf(req.url)
            if (parts === null) {
              sendJson(res, 404, { error: 'not found' })
              return
            }

            if (req.method === 'GET' && parts.length === 0) {
              sendJson(res, 200, {
                stats: stats,
                history: history.slice(-12).reverse(),
                latest: latest,
                config: { dataDir: dataDir, timeoutMs: timeoutMs },
              })
              return
            }

            if (req.method === 'GET' && parts[0] === 'view' && parts.length === 2) {
              const id = safeName(parts[1])
              const file = id === undefined ? undefined : join(runsDir, id, 'index.html')
              if (file === undefined || !existsSync(file)) {
                sendJson(res, 404, { error: 'no such run' })
                return
              }
              res.statusCode = 200
              res.setHeader('content-type', 'text/html; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(readFileSync(file))
              return
            }

            if (req.method === 'GET' && parts[0] === 'receipt' && parts.length === 2) {
              const id = safeName(parts[1])
              const file = id === undefined ? undefined : join(runsDir, id, 'receipt.json')
              if (file === undefined || !existsSync(file)) {
                sendJson(res, 404, { error: 'no such run' })
                return
              }
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(readFileSync(file))
              return
            }

            if (req.method === 'POST') {
              await readBody(req)
              sendJson(res, 404, { error: 'unknown method' })
              return
            }

            sendJson(res, 404, { error: 'not found' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}

/** Exposed for the test suite: the route shape is part of the contract. */
export const internals = {
  ROUTE: ROUTE,
  segmentsOf: segmentsOf,
  safeName: safeName,
  pngSize: pngSize,
  sha256: sha256,
  SECRET_PATTERNS: SECRET_PATTERNS,
}
