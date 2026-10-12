// The client half is CommonJS and expects the harness to supply React, so it is
// loaded here with that one dependency stubbed. Everything else under test is
// the real module the browser runs.
import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id === 'react') {
    return {
      createElement: function (type, props) {
        return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
      },
      useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
      useEffect: function () {},
    }
  }
  return originalRequire.apply(this, arguments)
}
const client = require('../src/client.cjs')
Module.prototype.require = originalRequire

test('the client half exports the cordis contract the harness reads', () => {
  assert.equal(client.name, 'dsh-ship-receipt')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
})

test('the client renders the same three zones the host computed', () => {
  // The two halves must not drift: a zone the host can emit but the client never
  // renders would make a section silently disappear from the panel.
  const zones = client.__test.ZONES.map(function (zone) { return zone.key })
  assert.deepEqual(zones, ['verified', 'local', 'unverified'])
  for (const zone of client.__test.ZONES) {
    assert.ok(zone.label.length > 0)
    assert.ok(zone.className.length > 0)
    assert.ok(zone.hint.length > 0)
  }
})

test('the 交付回执 view registers on conversation.view and tears down cleanly', () => {
  const disposers = []
  const registered = []
  global.document = {
    createElement: function () { return { dataset: {}, remove: function () {} } },
    head: { appendChild: function () {} },
  }
  const ctx = {
    effect: function (fn) { disposers.push(fn()) },
    slots: {
      inject: function (name, fn) {
        assert.equal(name, 'conversation.view')
        fn()
      },
      register: function (meta, component) {
        registered.push({ meta: meta, component: component })
        return function () {}
      },
    },
  }

  client.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.id, 'ship-receipt')
  assert.equal(registered[0].meta.label, '交付回执')
  // After dsh-daily (40) and dsh-vision-diff (45), before nothing in particular.
  assert.equal(registered[0].meta.order, 50)
  assert.equal(typeof registered[0].component, 'function')

  assert.equal(disposers.length, 2)
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  for (const dispose of disposers) dispose()
  delete global.document
})

test('a slot registration failure is contained instead of aborting the client boot', () => {
  const disposers = []
  global.document = {
    createElement: function () { return { dataset: {}, remove: function () {} } },
    head: { appendChild: function () {} },
  }
  const warnings = []
  const originalWarn = console.warn
  console.warn = function (message) { warnings.push(String(message)) }
  const ctx = {
    effect: function (fn) { disposers.push(fn()) },
    slots: {
      inject: function (name, fn) { fn() },
      register: function () { throw new Error('slot contract changed') },
    },
  }
  try {
    client.apply(ctx)
  } finally {
    console.warn = originalWarn
    delete global.document
  }
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('交付回执'))
})
