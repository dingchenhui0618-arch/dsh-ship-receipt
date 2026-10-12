// Client half of dsh-ship-receipt: the 交付回执 Tab.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// This half makes no judgements. It renders the zones the host computed, and in
// particular it renders an unverified section as a blank slot, because that is
// what the receipt says: there is nothing behind it. Re-adding prose here would
// quietly undo the plugin's whole rule.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-ship-receipt'
const POLL_MS = 5000

const ZONES = [
  { key: 'verified', label: '已验证', className: 'sr-verified', hint: '插件本进程刚测到的。' },
  { key: 'local', label: '仅本地', className: 'sr-local', hint: '本机观察到的，带命令与退出码。' },
  { key: 'unverified', label: '未验证', className: 'sr-unverified', hint: '没有证据，只留标签。' },
]

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-ship-receipt] listener failed', error)
    }
  })
}

function load() {
  fetch(API, { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    timer = setInterval(load, POLL_MS)
    load()
  }
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function useSnap() {
  const [value, setValue] = React.useState(snap)
  React.useEffect(function () { return subscribe(setValue) }, [])
  return value
}

function absolute(page) {
  if (typeof page !== 'string' || page.length === 0) return ''
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin + page
  }
  return page
}

function Section(props) {
  const section = props.section
  return h('div', { className: 'sr-card' },
    h('h5', null, section.label),
    section.detail ? h('p', { className: 'sr-detail' }, section.detail) : null,
    section.evidence && section.evidence.length > 0
      ? h('table', { className: 'sr-table' }, h('tbody', null, section.evidence.map(function (item, index) {
        return h('tr', { key: index },
          h('th', null, item.label),
          h('td', { className: 'sr-mono' }, item.value))
      })))
      : null,
    section.missing && section.missing.length > 0
      ? section.missing.map(function (text, index) {
        return h('div', { key: index, className: 'sr-blank' }, text)
      })
      : null,
  )
}

function Zone(props) {
  const list = props.list || []
  return h('div', { className: 'sr-zone ' + props.zone.className },
    h('div', { className: 'sr-zonehead' },
      h('h4', null, props.zone.label),
      h('span', { className: 'sr-count' }, list.length + ' 项')),
    h('p', { className: 'sr-hint' }, props.zone.hint),
    list.length === 0
      ? h('div', { className: 'sr-empty' }, '（这一区没有条目）')
      : list.map(function (section, index) {
        return h(Section, { key: section.id + index, section: section })
      }),
  )
}

function Panel() {
  const state = useSnap()
  const data = state.data
  const latest = data && data.latest
  const receipt = latest && latest.receipt
  const history = (data && data.history) || []
  const stats = (data && data.stats) || {}

  return h('div', { className: 'sr-root' },
    h('div', { className: 'sr-head' },
      h('span', { className: 'sr-title' }, '交付回执'),
      h('span', { className: 'sr-sub' }, '证据分区：已验证 / 仅本地 / 未验证'),
      h('div', { className: 'sr-spacer' }),
      latest ? h('a', {
        className: 'sr-link',
        href: absolute(latest.page),
        target: '_blank',
        rel: 'noreferrer',
      }, '打开回执页') : null,
    ),

    state.error ? h('div', { className: 'sr-err' }, '与 host 通信失败：' + state.error) : null,

    h('div', { className: 'sr-bar' },
      h('span', null, '运行 ', h('b', null, String(stats.runs || 0))),
      h('span', null, '失败 ', h('b', null, String(stats.failed || 0))),
      receipt ? h('span', { className: 'sr-v' }, '已验证 ', h('b', null, String(receipt.counts.verified))) : null,
      receipt ? h('span', { className: 'sr-l' }, '仅本地 ', h('b', null, String(receipt.counts.local))) : null,
      receipt ? h('span', { className: 'sr-u' }, '未验证 ', h('b', null, String(receipt.counts.unverified))) : null,
    ),

    receipt === undefined || receipt === null
      ? h('div', { className: 'sr-empty' }, '还没有出过回执。让 agent 调用 ship_receipt，传项目目录即可（可带上测试与构建命令）。')
      : h('div', null,
        h('div', { className: 'sr-sub' },
          String(receipt.project.name || receipt.project.dir) + ' · ' + String(receipt.generatedAt)),
        ZONES.map(function (zone) {
          return h(Zone, { key: zone.key, zone: zone, list: receipt.zones[zone.key] })
        }),
      ),

    history.length > 0 ? h('div', null,
      h('div', { className: 'sr-sub' }, '历史'),
      h('div', { className: 'sr-hist' }, history.map(function (item) {
        return h('a', {
          key: item.id,
          href: absolute(item.page),
          target: '_blank',
          rel: 'noreferrer',
        }, item.id + '（' + item.counts.verified + '/' + item.counts.local + '/' + item.counts.unverified + '）')
      })),
    ) : null,
  )
}

function apply(ctx) {
  // dsh can unload a plugin at runtime, so every registration has a teardown.
  // The shared poll outlives one apply(), so it gets its own disposer.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-ship-receipt'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // Guarded and normalised: a changed slot contract must degrade this one panel
  // and say so, not abort the client boot for every other plugin.
  ctx.slots.inject('conversation.view', function () {
    let dispose
    try {
      dispose = ctx.slots.register(
        { name: 'conversation.view', id: 'ship-receipt', order: 50, label: '交付回执' },
        Panel,
      )
    } catch (error) {
      dispose = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-ship-receipt] could not register the 交付回执 view', error)
      }
    }
    return typeof dispose === 'function' ? dispose : function () {}
  })
}

module.exports = {
  name: 'dsh-ship-receipt',
  inject: ['slots'],
  apply: apply,
  // Test seam: the rule that an unverified section loses its prose is the plugin
  // in one line, and it needs no DOM to verify.
  __test: { ZONES: ZONES },
}
