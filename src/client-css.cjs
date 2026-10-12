// Client styles for dsh-ship-receipt.
//
// The zone colours are the whole visual language: green means the plugin
// measured it, amber means it happened on this machine, grey dashed means there
// is nothing behind it. Nothing else in the panel competes with that.

module.exports = [
  '.sr-root{display:flex;flex-direction:column;gap:14px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}',
  '.sr-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
  '.sr-title{font-size:15px;font-weight:600}',
  '.sr-sub{opacity:.6;font-size:12px}',
  '.sr-spacer{flex:1}',
  '.sr-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}',
  '.sr-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.sr-bar{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:7px 10px;opacity:.85}',
  '.sr-bar b{font-variant-numeric:tabular-nums}',
  '.sr-v{color:color-mix(in srgb,#16a34a 80%,currentColor)}',
  '.sr-l{color:color-mix(in srgb,#d97706 82%,currentColor)}',
  '.sr-u{opacity:.6}',
  '.sr-zone{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px;padding:10px 12px}',
  '.sr-zone.sr-verified{border-color:color-mix(in srgb,#16a34a 40%,transparent)}',
  '.sr-zone.sr-local{border-color:color-mix(in srgb,#d97706 40%,transparent)}',
  '.sr-zone.sr-unverified{border-style:dashed}',
  '.sr-zonehead{display:flex;align-items:baseline;gap:8px}',
  '.sr-zonehead h4{margin:0;font-size:12px;font-weight:600}',
  '.sr-count{font-size:11px;opacity:.55}',
  '.sr-hint{font-size:11px;opacity:.55;margin:4px 0 8px}',
  '.sr-card{border:1px solid color-mix(in srgb,currentColor 11%,transparent);border-radius:7px;padding:8px 10px;margin-bottom:6px;background:color-mix(in srgb,currentColor 3%,transparent)}',
  '.sr-card h5{margin:0 0 4px;font-size:12px;font-weight:600}',
  '.sr-detail{font-size:12px;margin:0 0 5px}',
  '.sr-table{border-collapse:collapse;width:100%}',
  '.sr-table th,.sr-table td{text-align:left;padding:2px 6px;border-bottom:1px solid color-mix(in srgb,currentColor 9%,transparent);font-size:11.5px;vertical-align:top}',
  '.sr-table th{opacity:.55;font-weight:600;width:34%}',
  '.sr-table tr:last-child th,.sr-table tr:last-child td{border-bottom:none}',
  '.sr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
  '.sr-blank{border:1px dashed color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:9px;text-align:center;opacity:.6;font-size:11.5px}',
  '.sr-empty{opacity:.5;font-size:11.5px}',
  '.sr-err{border:1px solid color-mix(in srgb,#dc2626 50%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}',
  '.sr-hist{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}',
  '.sr-hist a{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:6px;padding:2px 8px;opacity:.8;color:inherit;text-decoration:none}',
  '.sr-link{color:inherit;text-decoration:underline;text-underline-offset:2px}',
].join('')
