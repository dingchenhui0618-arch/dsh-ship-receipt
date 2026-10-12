// The host half is driven through a stub cordis Context, the way the harness
// drives it: a real tool registration, a real HTTP handler, and a real git
// repository on disk. The point of these tests is that the receipt measures
// rather than transcribes — so the assertions are about what the plugin found
// out for itself.
import test from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject, internals } from '../src/host.js'

function runGit(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ship-'))
  runGit(dir, ['init', '-q'])
  runGit(dir, ['config', 'user.email', 't@example.com'])
  runGit(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n.env\n')
  writeFileSync(join(dir, 'index.js'), 'export const x = 1\n')
  runGit(dir, ['add', '-A'])
  runGit(dir, ['commit', '-q', '-m', 'initial commit'])
  return dir
}

/** A PNG header is all the dimension reader needs, so a header alone is a real
 *  fixture for this purpose rather than a fake file. */
function pngBytes(width, height) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const u32 = function (at, value) {
    bytes[at] = (value >>> 24) & 0xff
    bytes[at + 1] = (value >>> 16) & 0xff
    bytes[at + 2] = (value >>> 8) & 0xff
    bytes[at + 3] = value & 0xff
  }
  u32(16, width)
  u32(20, height)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function fakeReq(method, url, body) {
  const handlers = {}
  const req = { method: method, url: url }
  req.on = function (event, cb) {
    handlers[event] = cb
    return req
  }
  req.destroy = function () {}
  setImmediate(function () {
    if (body !== undefined && handlers.data) handlers.data(JSON.stringify(body))
    if (handlers.end) handlers.end()
  })
  return req
}

function fakeRes() {
  let resolve
  const done = new Promise(function (r) { resolve = r })
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader: function (key, value) { res.headers[key] = value },
    end: function (chunk) {
      res.body = chunk
      resolve()
    },
  }
  return { res: res, done: done }
}

function setup(options) {
  const dataDir = mkdtempSync(join(tmpdir(), 'shipdata-'))
  const registered = []
  const routes = []
  const effects = []
  // Mirror cordis: a hard service is only reachable if the plugin declared it.
  // An earlier version of this stub handed out `tools` unconditionally and so
  // passed while the real harness refused to activate the plugin at all.
  const declared = new Set(inject)
  const ctx = {
    effect: function (fn) { effects.push(fn()) },
    get: function () { return undefined },
  }
  if (declared.has('tools')) {
    ctx.tools = { register: function (d) { registered.push(d); return function () {} } }
  }
  if (declared.has('webServer')) {
    ctx.webServer = { register: function (r) { routes.push(r); return function () {} } }
  }
  apply(ctx, Object.assign({ dataDir: dataDir }, options || {}))
  return { tool: registered[0], routes: routes, effects: effects, dataDir: dataDir }
}

async function get(built, url) {
  const { res, done } = fakeRes()
  await built.routes[0].handler(fakeReq('GET', url), res)
  await done
  return { status: res.statusCode, body: res.body, headers: res.headers }
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      // best effort
    }
  }
}

function findZone(receipt, id) {
  for (const zone of ['verified', 'local', 'unverified']) {
    const found = receipt.zones[zone].find(function (section) { return section.id === id })
    if (found !== undefined) return { zone: zone, section: found }
  }
  return undefined
}

test('the plugin declares every service it reaches for', () => {
  assert.equal(name, 'dsh-ship-receipt')
  // Both are hard dependencies: cordis refuses `ctx.tools` and `ctx.webServer`
  // unless they were injected, and the stub above now enforces the same rule.
  assert.deepEqual(inject.slice().sort(), ['tools', 'webServer'])
})

test('the tool declares a schema, an output renderer and a read presentation', () => {
  const built = setup()
  assert.equal(built.tool.name, 'ship_receipt')
  assert.deepEqual(built.tool.parameters.required, ['dir'])
  assert.equal(built.tool.parameters.additionalProperties, false)
  assert.equal(typeof built.tool.output.render, 'function')
  // Two receipts in one repo would race on the same test run.
  assert.equal(built.tool.isConcurrencySafe({}), false)
  assert.equal(built.tool.presentCall({ dir: '/tmp/x' }).kind, 'read')
  assert.equal(built.effects.length, 2)
  cleanup(built.dataDir)
})

test('git facts are measured, so they land in 已验证', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo }, {})

  const git = findZone(out.receipt, 'git')
  assert.equal(git.zone, 'verified')
  const values = git.section.evidence.map(function (item) { return item.value }).join(' | ')
  const head = runGit(repo, ['rev-parse', 'HEAD']).trim()
  assert.ok(values.includes(head), 'the real commit is in the receipt: ' + values)
  assert.ok(values.includes('initial commit'))
  assert.ok(values.includes('干净'), 'a clean tree is stated as measured, not assumed')
  cleanup(built.dataDir, repo)
})

test('a dirty working tree is reported instead of quietly ignored', async () => {
  const built = setup()
  const repo = makeRepo()
  writeFileSync(join(repo, 'index.js'), 'export const x = 2\n')
  const out = await built.tool.execute({ dir: repo }, {})

  const git = findZone(out.receipt, 'git')
  assert.equal(git.zone, 'verified')
  const values = git.section.evidence.map(function (item) { return item.value }).join(' | ')
  assert.ok(values.includes('1 个文件有改动'))
  // And it says out loud that the commit is therefore not the whole story.
  assert.ok(git.section.detail.includes('不是当前全部内容'))
  cleanup(built.dataDir, repo)
})

test('the three pre-push checks are run by the plugin itself', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo }, {})

  for (const id of ['check-secrets', 'check-gitignore', 'check-cleanup']) {
    const found = findZone(out.receipt, id)
    assert.ok(found !== undefined, id + ' must exist')
    assert.equal(found.zone, 'verified', id + ' is measured here, so it is verified')
  }
  const secrets = findZone(out.receipt, 'check-secrets').section
  assert.equal(secrets.evidence[0].value.includes('clean'), true)
  cleanup(built.dataDir, repo)
})

test('the secret scan actually finds a planted key', async () => {
  const built = setup()
  const repo = makeRepo()
  // Assembled at runtime on purpose. A literal that matches the scanner's own
  // pattern makes this repository fail its own pre-push secret scan — which is
  // exactly what happened the first time this plugin ran on itself.
  const planted = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345'
  writeFileSync(join(repo, 'leak.js'), 'const key = "' + planted + '"\n')
  runGit(repo, ['add', '-A'])
  const out = await built.tool.execute({ dir: repo }, {})

  const secrets = findZone(out.receipt, 'check-secrets').section
  assert.equal(secrets.evidence.some(function (item) { return item.label === 'leak.js' }), true)
  assert.ok(secrets.detail.includes('不应该推送'))
  cleanup(built.dataDir, repo)
})

test('this repository itself has nothing credential-shaped to find', async () => {
  // The receipt ran on this repo during development and flagged its own test
  // fixture. Guarding it here means the fixture cannot quietly come back.
  const built = setup()
  const out = await built.tool.execute({ dir: join(import.meta.dirname, '..') }, {})
  const secrets = findZone(out.receipt, 'check-secrets').section
  assert.equal(secrets.evidence[0].value.includes('clean'), true, 'found: ' + JSON.stringify(secrets.evidence))
  cleanup(built.dataDir)
})

test('a check is executed, and its exit code decides the wording', async () => {
  const built = setup()
  const repo = makeRepo()
  const pass = await built.tool.execute({
    dir: repo,
    checks: [{ label: '测试', command: 'node --version' }],
  }, {})
  const passed = findZone(pass.receipt, 'check-测试')
  assert.equal(passed.zone, 'verified', 'the plugin ran it, so the reader gets a measurement')
  assert.equal(passed.section.detail.includes('退出码 0'), true)
  assert.equal(passed.section.evidence[1].value, '0')

  const fail = await built.tool.execute({
    dir: repo,
    checks: [{ label: '构建', command: 'node -e process.exit(3)' }],
  }, {})
  const failed = findZone(fail.receipt, 'check-构建')
  assert.equal(failed.zone, 'verified')
  assert.equal(failed.section.evidence[1].value, '3')
  assert.ok(failed.section.detail.includes('没有通过'))
  cleanup(built.dataDir, repo)
})

test('a check reported rather than run is 仅本地, never 已验证', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({
    dir: repo,
    checks: [{ label: '远端 CI', command: 'npm test', run: false, exitCode: 0, output: 'all green' }],
  }, {})
  const found = findZone(out.receipt, 'check-远端 CI')
  assert.equal(found.zone, 'local')
  assert.equal(found.section.detail.includes('没有自己运行'), true)
  assert.equal(found.section.evidence[1].value, '0')
  cleanup(built.dataDir, repo)
})

test('a claim is unverified and its statement never reaches the page', async () => {
  const built = setup()
  const repo = makeRepo()
  const claim = '生产环境已完整验证，客户已验收。'
  const out = await built.tool.execute({
    dir: repo,
    claims: [{ label: '生产验证', statement: claim }],
  }, {})

  const found = findZone(out.receipt, 'claim-生产验证')
  assert.equal(found.zone, 'unverified')
  assert.equal(found.section.detail, '')

  const html = readFileSync(out.html, 'utf8')
  const summary = built.tool.output.render({}, out)[0].text
  assert.ok(!html.includes(claim), 'a confident sentence must not survive into the page')
  assert.ok(!summary.includes(claim))
  assert.ok(html.includes('生产验证'), 'the label does, so the gap is visible')
  cleanup(built.dataDir, repo)
})

test('artifacts are hashed and measured, and a PNG gets its dimensions', async () => {
  const built = setup()
  const repo = makeRepo()
  writeFileSync(join(repo, 'shot.png'), Buffer.from(pngBytes(1440, 900)))
  const out = await built.tool.execute({ dir: repo, artifacts: ['shot.png', 'index.js'] }, {})

  const artifacts = findZone(out.receipt, 'artifacts')
  assert.equal(artifacts.zone, 'verified')
  const shot = artifacts.section.evidence.find(function (item) { return item.label === 'shot.png' })
  assert.ok(shot.value.includes('1440×900'), 'the PNG dimensions are read from the file: ' + shot.value)
  assert.ok(shot.value.includes('sha256'))
  assert.equal(shot.value.includes(String(Buffer.from(pngBytes(1440, 900)).length) + ' 字节'), true)
  cleanup(built.dataDir, repo)
})

test('a declared artifact that is missing is a finding, not a footnote', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo, artifacts: ['nope.png'] }, {})
  const missing = findZone(out.receipt, 'artifacts-missing')
  assert.ok(missing !== undefined)
  assert.equal(missing.zone, 'verified')
  assert.ok(missing.section.evidence[0].value.includes('nope.png'))
  cleanup(built.dataDir, repo)
})

test('an unpushed commit is called out rather than left for the reader to notice', async () => {
  const built = setup()
  const bare = mkdtempSync(join(tmpdir(), 'shipbare-'))
  runGit(bare, ['init', '-q', '--bare'])
  const repo = makeRepo()
  runGit(repo, ['remote', 'add', 'origin', bare])
  runGit(repo, ['push', '-q', '-u', 'origin', 'HEAD'])
  writeFileSync(join(repo, 'index.js'), 'export const x = 3\n')
  runGit(repo, ['add', '-A'])
  runGit(repo, ['commit', '-q', '-m', 'second'])

  const out = await built.tool.execute({ dir: repo }, {})
  const push = findZone(out.receipt, 'push')
  assert.ok(push !== undefined, 'an unpushed commit must produce its own section')
  assert.ok(push.section.detail.includes('没有推送'))
  cleanup(built.dataDir, repo, bare)
})

test('a directory that is not a repo is measured as such, not left blank', async () => {
  const built = setup()
  const dir = mkdtempSync(join(tmpdir(), 'plain-'))
  writeFileSync(join(dir, 'a.txt'), 'hello')
  const out = await built.tool.execute({ dir: dir }, {})

  // "This is not a repository" is something the plugin found out by running git,
  // so it is a measurement — and it carries the failing command as its evidence.
  const gitSection = findZone(out.receipt, 'git')
  assert.equal(gitSection.zone, 'verified')
  assert.ok(gitSection.section.detail.includes('不是一个 git 仓库'))
  assert.ok(gitSection.section.evidence.some(function (item) { return item.value.includes('非零退出') }))
  cleanup(built.dataDir, dir)
})

test('a check declared without a command is an empty slot, and explains itself', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo, checks: [{ label: '没给命令的检查' }] }, {})
  const found = findZone(out.receipt, 'check-没给命令的检查')
  // Nothing ran and nothing was reported, so nothing may be shown as a result.
  assert.equal(found.zone, 'unverified')
  assert.equal(found.section.detail, '')
  assert.ok(found.section.missing[0].includes('没有提供命令'))
  cleanup(built.dataDir, repo)
})

test('a missing or absent directory is a clear failure', async () => {
  const built = setup()
  await assert.rejects(function () { return built.tool.execute({}, {}) }, /缺少 dir/)
  await assert.rejects(
    function () { return built.tool.execute({ dir: join(tmpdir(), 'definitely-not-here-xyz') }, {}) },
    /目录不存在|dsh-ship-receipt/,
  )
  cleanup(built.dataDir)
})

test('both artifacts are written and the JSON matches what the tool returned', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo }, {})
  assert.equal(existsSync(out.html), true)
  assert.equal(existsSync(out.json), true)
  const fromDisk = JSON.parse(readFileSync(out.json, 'utf8'))
  assert.deepEqual(fromDisk.counts, out.receipt.counts)
  assert.ok(readFileSync(out.html, 'utf8').includes('已验证'))
  cleanup(built.dataDir, repo)
})

test('a failing tool call is tagged so it is traceable in a transcript', async () => {
  const built = setup()
  await assert.rejects(
    function () { return built.tool.execute({}, {}) },
    function (error) {
      assert.ok(error.message.startsWith('[dsh-ship-receipt] '))
      return true
    },
  )
  cleanup(built.dataDir)
})

test('state, the page and the JSON are served, and traversal is refused', async () => {
  const built = setup()
  const repo = makeRepo()
  const out = await built.tool.execute({ dir: repo }, {})

  const state = await get(built, '/dsh-ship-receipt')
  assert.equal(state.status, 200)
  const body = JSON.parse(state.body)
  assert.equal(body.stats.runs, 1)
  assert.equal(body.latest.id, out.id)
  assert.ok(body.latest.receipt.counts.total > 0)
  assert.equal(body.history.length, 1)
  assert.equal(body.history[0].receipt, undefined, 'history stays lean')

  const page = await get(built, out.page)
  assert.equal(page.status, 200)
  assert.ok(String(page.headers['content-type']).includes('text/html'))

  const json = await get(built, '/dsh-ship-receipt/receipt/' + out.id)
  assert.equal(json.status, 200)
  assert.equal(JSON.parse(json.body).counts.verified, out.receipt.counts.verified)

  assert.equal((await get(built, '/dsh-ship-receipt/view/nope')).status, 404)
  assert.equal((await get(built, '/dsh-ship-receipt/view/..%2F..%2Fstate.json')).status, 404)
  assert.equal((await get(built, '/dsh-ship-receipt/other')).status, 404)
  cleanup(built.dataDir, repo)
})

test('the segment helper accepts the prefix and only the prefix', () => {
  assert.deepEqual(internals.segmentsOf('/dsh-ship-receipt'), [])
  assert.deepEqual(internals.segmentsOf('/dsh-ship-receipt?x=1'), [])
  assert.deepEqual(internals.segmentsOf('/dsh-ship-receipt/view/abc'), ['view', 'abc'])
  assert.equal(internals.segmentsOf('/other'), null)
  assert.equal(internals.segmentsOf('/dsh-ship-receiptXYZ'), null, 'a near-miss prefix must not answer as state')
  assert.equal(internals.safeName('../x'), undefined)
  assert.equal(internals.safeName('a/b'), undefined)
  assert.equal(internals.safeName('ok'), 'ok')
})

test('the PNG header reader answers only for real PNGs', () => {
  assert.deepEqual(internals.pngSize(pngBytes(10, 20)), { width: 10, height: 20 })
  assert.equal(internals.pngSize(new Uint8Array(40).fill(7)), undefined)
  assert.equal(internals.pngSize(new Uint8Array(4)), undefined)
})

test('every registration is reversible', () => {
  const built = setup()
  for (const dispose of built.effects) assert.equal(typeof dispose, 'function')
  for (const dispose of built.effects) dispose()
  cleanup(built.dataDir)
})
