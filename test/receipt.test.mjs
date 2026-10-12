// The zoning rule is the plugin. Everything else is presentation.
//
// The rule: a section's zone comes from its evidence, never from how confident
// its wording is — and a section with no evidence keeps its label and LOSES ITS
// PROSE. These tests are written to fail loudly if a confident sentence ever
// reaches a reader without something behind it.
import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  NO_EVIDENCE,
  ZONES,
  ZONE_LABELS,
  buildReceipt,
  freezeSection,
  renderReceipt,
  summarise,
  zoneFor,
} from '../src/receipt.js'

const CONFIDENT = '所有测试均已通过，构建产物已验证，可以放心发布。'
const EVIDENCE = [{ label: '命令', value: 'node --test' }, { label: '退出码', value: '0' }]

test('the three zones are the ones the plugin promises', () => {
  assert.deepEqual(ZONES, ['verified', 'local', 'unverified'])
  assert.equal(ZONE_LABELS.verified, '已验证')
  assert.equal(ZONE_LABELS.local, '仅本地')
  assert.equal(ZONE_LABELS.unverified, '未验证')
})

test('a zone comes from the evidence, not from the wording', () => {
  assert.equal(zoneFor({ detail: CONFIDENT }), 'unverified')
  assert.equal(zoneFor({ detail: CONFIDENT, evidence: [] }), 'unverified')
  assert.equal(zoneFor({ detail: '', evidence: EVIDENCE }), 'local')
  assert.equal(zoneFor({ detail: '', evidence: EVIDENCE, measured: true }), 'verified')
  // `measured: true` with nothing to show for it is not verified, it is empty.
  assert.equal(zoneFor({ measured: true }), 'unverified')
  assert.equal(zoneFor({ measured: true, evidence: [] }), 'unverified')
})

test('zoneFor tolerates rubbish instead of throwing', () => {
  assert.equal(zoneFor(undefined), 'unverified')
  assert.equal(zoneFor(null), 'unverified')
  assert.equal(zoneFor('a string'), 'unverified')
  assert.equal(zoneFor({ evidence: [null, undefined] }), 'unverified')
  assert.equal(zoneFor({ evidence: [null, { label: 'x', value: 'y' }] }), 'local')
})

test('an unverified section loses its prose — the headline rule', () => {
  const frozen = freezeSection({ id: 'a', label: '测试结果', detail: CONFIDENT })
  assert.equal(frozen.zone, 'unverified')
  assert.equal(frozen.detail, '', 'a claim with nothing behind it must not keep its sentence')
  assert.deepEqual(frozen.evidence, [])
  assert.deepEqual(frozen.missing, [NO_EVIDENCE])
})

test('the dropped prose appears nowhere in the rendered page', () => {
  const receipt = buildReceipt({
    generatedAt: '2026-10-11T00:00:00.000Z',
    project: { dir: '/tmp/p', name: 'p' },
    sections: [
      { id: 'tests', label: '测试结果', detail: CONFIDENT },
      { id: 'git', label: 'git 状态', measured: true, evidence: [{ label: 'commit', value: 'abc123' }] },
    ],
  })
  const html = renderReceipt(receipt)
  const text = summarise(receipt)
  // Not on the page, not in the summary. A receipt that shows the sentence
  // beside a grey badge still puts the claim in front of a reader.
  assert.ok(!html.includes(CONFIDENT))
  assert.ok(!text.includes(CONFIDENT))
  assert.ok(html.includes('测试结果'), 'the label stays')
  assert.ok(html.includes(NO_EVIDENCE), 'and the slot says it is empty')
  assert.ok(text.includes('测试结果'))
  assert.ok(text.includes(NO_EVIDENCE))
})

test('a verified section keeps its prose and its evidence', () => {
  const frozen = freezeSection({
    id: 'git',
    label: 'git 状态',
    measured: true,
    detail: '工作区干净。',
    evidence: [{ label: 'commit', value: 'abc' }],
  })
  assert.equal(frozen.zone, 'verified')
  assert.equal(frozen.detail, '工作区干净。')
  assert.deepEqual(frozen.evidence, [{ label: 'commit', value: 'abc' }])
  assert.deepEqual(frozen.missing, [])
})

test('a local-only section keeps its evidence but is not called verified', () => {
  const frozen = freezeSection({ id: 'c', label: '测试', detail: '由调用方报告。', evidence: EVIDENCE })
  assert.equal(frozen.zone, 'local')
  assert.equal(frozen.detail, '由调用方报告。')
  assert.equal(frozen.evidence.length, 2)
})

test('a claimed missing reason survives, otherwise the marker is used', () => {
  const custom = freezeSection({ id: 'x', label: 'x', missing: ['没有 CI 记录'] })
  assert.deepEqual(custom.missing, ['没有 CI 记录'])
  const fallback = freezeSection({ id: 'y', label: 'y' })
  assert.deepEqual(fallback.missing, [NO_EVIDENCE])
})

test('evidence values are stringified so a number cannot break the page', () => {
  const frozen = freezeSection({
    id: 'a',
    label: 'a',
    measured: true,
    evidence: [{ label: '退出码', value: 0 }, { label: '尺寸', value: null }],
  })
  assert.deepEqual(frozen.evidence, [{ label: '退出码', value: '0' }, { label: '尺寸', value: '' }])
})

test('buildReceipt groups into the three zones and counts them', () => {
  const receipt = buildReceipt({
    generatedAt: 'now',
    project: { dir: '/p', name: 'p' },
    sections: [
      { id: 'g', label: 'git', measured: true, evidence: [{ label: 'a', value: 'b' }] },
      { id: 'c', label: '测试', evidence: EVIDENCE },
      { id: 'u1', label: '未验证一', detail: CONFIDENT },
      { id: 'u2', label: '未验证二' },
    ],
  })
  assert.equal(receipt.zones.verified.length, 1)
  assert.equal(receipt.zones.local.length, 1)
  assert.equal(receipt.zones.unverified.length, 2)
  assert.deepEqual(receipt.counts, { verified: 1, local: 1, unverified: 2, total: 4 })
})

test('buildReceipt tolerates nothing at all', () => {
  const receipt = buildReceipt(undefined)
  assert.equal(receipt.counts.total, 0)
  assert.deepEqual(receipt.zones.verified, [])
  assert.equal(typeof renderReceipt(receipt), 'string')
  assert.equal(typeof summarise(receipt), 'string')
  assert.equal(buildReceipt(null).counts.total, 0)
  assert.equal(buildReceipt({ sections: 'not an array' }).counts.total, 0)
})

test('a section with no label is still labelled', () => {
  const receipt = buildReceipt({ sections: [{ detail: 'x' }] })
  assert.equal(receipt.zones.unverified[0].label, '未命名')
})

test('the summary states the zoning rule and flags leftover blanks', () => {
  const receipt = buildReceipt({
    generatedAt: 'now',
    project: { dir: '/p', name: 'demo' },
    sections: [
      { id: 'g', label: 'git', measured: true, evidence: [{ label: 'commit', value: 'abc' }] },
      { id: 'u', label: '生产验证' },
    ],
  })
  const text = summarise(receipt)
  assert.ok(text.includes('## 已验证（1）'))
  assert.ok(text.includes('## 仅本地（0）'))
  assert.ok(text.includes('## 未验证（1）'))
  assert.ok(text.includes('已验证 1 / 仅本地 0 / 未验证 1'))
  assert.ok(text.includes('只留了标签'))
})

test('the page is self-contained and escapes what it renders', () => {
  const receipt = buildReceipt({
    generatedAt: '<script>alert(1)</script>',
    project: { dir: '/p', name: '<b>bold</b>' },
    sections: [
      {
        id: 'g',
        label: '<img src=x onerror=alert(1)>',
        measured: true,
        evidence: [{ label: 'x', value: '"quoted" & <angled>' }],
      },
    ],
  })
  const html = renderReceipt(receipt)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'the timestamp is escaped')
  assert.ok(!html.includes('<b>bold</b>'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'))
  assert.ok(html.includes('&amp;'))
  // Nothing external: this page is meant to be sent to someone, so it must still
  // render with no server, no relative path and no asset directory.
  assert.ok(!/(src|href)="https?:/.test(html))
})

test('the page shows all three zones even when one is empty', () => {
  const html = renderReceipt(buildReceipt({ sections: [] }))
  for (const zone of ZONES) {
    assert.ok(html.includes(ZONE_LABELS[zone]), zone + ' must be visible')
  }
  assert.ok(html.includes('（这一区没有条目）'))
})

test('the page states the zoning rule in its footer rather than leaving it implied', () => {
  const html = renderReceipt(buildReceipt({ sections: [] }))
  assert.ok(html.includes('分区由证据决定'))
  const custom = renderReceipt(buildReceipt({ sections: [], footer: '自定义落款' }))
  assert.ok(custom.includes('自定义落款'))
})
