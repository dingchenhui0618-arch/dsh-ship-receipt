// The receipt: what may be claimed, and in which zone.
//
// The product decision this module encodes is that a section's zone is decided
// by its EVIDENCE, never by how confident its wording sounds. Three zones, and
// the rule that makes them mean something:
//
//   已验证   the plugin measured it itself, in this process, just now.
//   仅本地   there is evidence, but a person or an agent reported it and it was
//            only ever observed on this machine.
//   未验证   there is no evidence. The section keeps its label and LOSES ITS
//            PROSE.
//
// That last rule is the entire point. A confidently written claim with nothing
// behind it is what a receipt exists to prevent, so an unverified section is
// rendered as an explicit blank slot rather than filled with a sentence. The
// user's own words for the problem this solves: writing too little drops
// evidence, writing too much oversteps — and the two failures look identical in
// a paragraph.
//
// Everything here is pure: no clock, no I/O, no git. The host gathers facts and
// hands them over; this module only decides what they add up to.

export const ZONES = ['verified', 'local', 'unverified']

export const ZONE_LABELS = {
  verified: '已验证',
  local: '仅本地',
  unverified: '未验证',
}

export const ZONE_HINTS = {
  verified: '插件本进程刚刚自己测出来的：git 状态、文件哈希与尺寸、密钥扫描结论。',
  local: '有证据，但只是本机观察到的：命令、退出码、输出都在下面，未经独立复核。',
  unverified: '没有任何证据。这里只留标签，不补话。',
}

export const NO_EVIDENCE = '（没有证据，留空）'

const EMPTY_SECTION = {
  id: 'unknown',
  label: '未命名',
  detail: '',
  evidence: [],
  missing: [NO_EVIDENCE],
}

/** A section's zone, decided by what backs it. */
export function zoneFor(section) {
  const evidence = section !== null && typeof section === 'object' && Array.isArray(section.evidence)
    ? section.evidence.filter(function (item) { return item !== null && item !== undefined })
    : []
  if (evidence.length === 0) return 'unverified'
  return section.measured === true ? 'verified' : 'local'
}

/**
 * Freeze one section into its zoned form.
 *
 * An unverified section loses `detail` outright. Keeping the text and labelling
 * it "unverified" would still put the claim in front of a reader, and a claim in
 * front of a reader is read as a claim no matter what colour the badge is.
 */
export function freezeSection(section) {
  const source = section !== null && typeof section === 'object' ? section : EMPTY_SECTION
  const zone = zoneFor(source)
  const label = String(source.label === undefined || source.label === null ? '' : source.label).trim()
  const evidence = Array.isArray(source.evidence)
    ? source.evidence.filter(function (item) { return item !== null && item !== undefined })
    : []

  return {
    id: String(source.id === undefined || source.id === null ? label : source.id),
    label: label.length > 0 ? label : '未命名',
    zone: zone,
    // Zone-gated content. This line is the plugin.
    detail: zone === 'unverified' ? '' : String(source.detail === undefined || source.detail === null ? '' : source.detail),
    evidence: zone === 'unverified' ? [] : evidence.map(function (item) {
      return {
        label: String(item.label === undefined ? '' : item.label),
        value: String(item.value === undefined || item.value === null ? '' : item.value),
      }
    }),
    missing: zone === 'unverified'
      ? (Array.isArray(source.missing) && source.missing.length > 0 ? source.missing.map(String) : [NO_EVIDENCE])
      : [],
  }
}

/**
 * Assemble the receipt from collected facts and declared claims.
 *
 * @param {{generatedAt?:string, project?:{dir?:string,name?:string},
 *          sections?:object[], footer?:string}} input
 */
export function buildReceipt(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const sections = (Array.isArray(source.sections) ? source.sections : []).map(freezeSection)

  const zones = { verified: [], local: [], unverified: [] }
  for (const section of sections) zones[section.zone].push(section)

  return {
    generatedAt: String(source.generatedAt === undefined || source.generatedAt === null ? '' : source.generatedAt),
    project: {
      dir: String(source.project !== undefined && source.project !== null && source.project.dir !== undefined ? source.project.dir : ''),
      name: String(source.project !== undefined && source.project !== null && source.project.name !== undefined ? source.project.name : ''),
    },
    zones: zones,
    counts: {
      verified: zones.verified.length,
      local: zones.local.length,
      unverified: zones.unverified.length,
      total: sections.length,
    },
    footer: String(source.footer === undefined || source.footer === null ? '' : source.footer),
  }
}

/**
 * The text a reader (usually a model) gets instead of the page.
 *
 * Unverified sections appear by name and nothing else, because the summary has
 * to obey the same rule the page does.
 */
export function summarise(receipt) {
  const lines = []
  const project = receipt.project.name.length > 0 ? receipt.project.name : receipt.project.dir
  lines.push('交付回执 · ' + project)
  lines.push('生成于 ' + (receipt.generatedAt.length > 0 ? receipt.generatedAt : '（无时间）'))
  lines.push('')

  for (const zone of ZONES) {
    const list = receipt.zones[zone]
    lines.push('## ' + ZONE_LABELS[zone] + '（' + list.length + '）')
    if (list.length === 0) {
      lines.push('  （无）')
    }
    for (const section of list) {
      lines.push('  - ' + section.label + (section.detail.length > 0 ? '：' + section.detail : ''))
      for (const item of section.evidence) {
        lines.push('      · ' + item.label + ' ' + item.value)
      }
      for (const missing of section.missing) {
        lines.push('      · ' + missing)
      }
    }
    lines.push('')
  }

  const unverified = receipt.counts.unverified
  lines.push('共 ' + receipt.counts.total + ' 项：已验证 ' + receipt.counts.verified +
    ' / 仅本地 ' + receipt.counts.local + ' / 未验证 ' + unverified + '。')
  if (unverified > 0) {
    lines.push('未验证的 ' + unverified + ' 项只留了标签，没有补话——它们没有证据可引。')
  }
  return lines.join('\n')
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sectionHtml(section) {
  const evidence = section.evidence.map(function (item) {
    return '<tr><th>' + escapeHtml(item.label) + '</th><td class="mono">' + escapeHtml(item.value) + '</td></tr>'
  }).join('')

  const missing = section.missing.map(function (text) {
    return '<div class="blank">' + escapeHtml(text) + '</div>'
  }).join('')

  return '<section class="card zone-' + section.zone + '">' +
    '<h3>' + escapeHtml(section.label) + '</h3>' +
    (section.detail.length > 0 ? '<p class="detail">' + escapeHtml(section.detail) + '</p>' : '') +
    (evidence.length > 0 ? '<table>' + evidence + '</table>' : '') +
    missing +
    '</section>'
}

/**
 * The standalone page.
 *
 * Self-contained like the rest of this author's plugins: it is meant to be sent
 * to someone, so it must not depend on a server, a relative path or an asset
 * directory still existing.
 */
export function renderReceipt(receipt) {
  const project = receipt.project.name.length > 0 ? receipt.project.name : receipt.project.dir
  const zoneBlock = function (zone) {
    const list = receipt.zones[zone]
    const body = list.length === 0
      ? '<p class="empty">（这一区没有条目）</p>'
      : list.map(sectionHtml).join('')
    return '<div class="zone zone-' + zone + '">' +
      '<div class="zonehead"><h2>' + ZONE_LABELS[zone] + '</h2>' +
      '<span class="count">' + list.length + '</span></div>' +
      '<p class="hint">' + escapeHtml(ZONE_HINTS[zone]) + '</p>' +
      body +
      '</div>'
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>交付回执 · ${escapeHtml(project)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#6b7280; --line:#d8dee4; --panel:#f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#8b949e; --line:#30363d; --panel:#161b22; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
  header { border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:22px; }
  h1 { font-size:19px; margin:0 0 6px; }
  .sub { color:var(--muted); font-size:13px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; word-break:break-all; }
  .bar { display:flex; gap:16px; flex-wrap:wrap; margin-top:12px; font-size:13px; }
  .bar b { font-variant-numeric:tabular-nums; }
  .bar .v { color:#15803d; } .bar .l { color:#b45309; } .bar .u { color:var(--muted); }
  .zone { margin-bottom:26px; padding:14px 16px; border-radius:10px; border:1px solid var(--line); }
  .zone-verified { border-color:color-mix(in srgb,#16a34a 42%,transparent); background:color-mix(in srgb,#16a34a 5%,transparent); }
  .zone-local { border-color:color-mix(in srgb,#d97706 42%,transparent); background:color-mix(in srgb,#d97706 5%,transparent); }
  .zone-unverified { border-style:dashed; background:transparent; }
  .zonehead { display:flex; align-items:baseline; gap:8px; }
  .zonehead h2 { font-size:15px; margin:0; }
  .count { font-size:12px; color:var(--muted); }
  .hint { color:var(--muted); font-size:12px; margin:4px 0 12px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; background:var(--panel); }
  .card h3 { font-size:13px; margin:0 0 6px; }
  .detail { margin:0 0 6px; }
  table { border-collapse:collapse; width:100%; }
  th,td { text-align:left; padding:3px 8px; border-bottom:1px solid var(--line); font-size:12px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; width:38%; }
  tr:last-child th, tr:last-child td { border-bottom:none; }
  .blank { border:1px dashed color-mix(in srgb,currentColor 30%,transparent); border-radius:6px; padding:10px; color:var(--muted); font-size:12px; text-align:center; }
  .empty { color:var(--muted); font-size:12px; }
  footer { margin-top:30px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>交付回执 · ${escapeHtml(project)}</h1>
  <div class="sub">生成于 ${escapeHtml(receipt.generatedAt)}${receipt.project.dir.length > 0 ? ' · ' + escapeHtml(receipt.project.dir) : ''}</div>
  <div class="bar">
    <span class="v">已验证 <b>${receipt.counts.verified}</b></span>
    <span class="l">仅本地 <b>${receipt.counts.local}</b></span>
    <span class="u">未验证 <b>${receipt.counts.unverified}</b></span>
    <span class="u">共 <b>${receipt.counts.total}</b></span>
  </div>
</header>
${zoneBlock('verified')}
${zoneBlock('local')}
${zoneBlock('unverified')}
<footer>${escapeHtml(receipt.footer.length > 0 ? receipt.footer : '分区由证据决定，不由措辞的自信程度决定。未验证的条目只留标签，不补话。')}</footer>
</body>
</html>
`
}
