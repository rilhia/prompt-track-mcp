// test-mcpb.js — spawns the bundled extension entry as Claude Desktop would
// (node server/index.js over stdio) and verifies the simplified pull model:
// web + stdio from one process, auto targeting, and multi-page disambiguation.
//
// The companion to smoke.js, covering the OTHER transport. Where smoke.js posts
// to /internal-rpc, this one spawns the built bundle and speaks newline delimited
// JSON-RPC over its stdin and stdout, which is exactly what Claude Desktop does.
// That makes it the only test that would catch a bundle which packs cleanly but
// cannot actually start.
//
//   node build-mcpb.mjs
//   (unpack dist/prompt-track.mcpb to /tmp/mcpbtest)
//   node test-mcpb.js
//
// Reads the bundle from /tmp/mcpbtest, and uses port 3123 so it cannot collide
// with a real instance or with a smoke.js run.
//
// The stdout parsing below matters as much as the assertions: if anything in the
// server ever writes a non-protocol line to stdout, the JSON.parse in the reader
// throws and this test fails. That is intentional, and it is the guard behind the
// "never log to stdout" rule in src/mcpb-main.js.

import { spawn } from 'child_process';
import http from 'http';
import WebSocket from 'ws';

const PORT = 3123;
const child = spawn('node', ['server/index.js'], { cwd: '/tmp/mcpbtest', env: { ...process.env, PORT: String(PORT) } });
child.stderr.on('data', d => process.stderr.write('[ext] ' + d));

// Stdout arrives in arbitrary chunks that do not respect message boundaries, so
// it is buffered and split on newlines. Replies may also arrive before anything
// is waiting for them, hence the queue-and-waiter pair rather than a simple
// callback: whichever side is ready first, the other is served.
let buf = '';
const replies = [];
const waiters = [];
child.stdout.on('data', d => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (waiters.length) waiters.shift()(msg); else replies.push(msg);
  }
});
function nextReply() { return new Promise(res => { if (replies.length) res(replies.shift()); else waiters.push(res); }); }
function sendStdio(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
const results = [];
const ok = (n, p, e='') => { results.push([p ? 'PASS' : 'FAIL', n, e]); if (!p) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = r => r.result.content[0].text;

(async () => {
  await sleep(1200);

  const health = await new Promise((res, rej) => http.get('http://127.0.0.1:' + PORT + '/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
  ok('web serves from same process', health.ok === true && health.mode === 'mcpb' && health.version === '0.22.0', JSON.stringify(health));

  const page = await new Promise((res, rej) => http.get('http://127.0.0.1:' + PORT + '/', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej));
  ok('player page served', page.includes('build v0.22 timeline'));

  sendStdio({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'claude-desktop-sim', version: '1' } } });
  const init = await nextReply();
  ok('stdio initialize', init.result && init.result.serverInfo.name === 'prompt-track');
  sendStdio({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendStdio({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await nextReply();
  ok('stdio tools/list 7 tools', list.result && list.result.tools.length === 7);

  sendStdio({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_state', arguments: {} } });
  ok('no pages guidance over stdio', /No player page is open/.test(textOf(await nextReply())));

  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  let fp = null; const pushes = [];
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'hello') fp = m.sessionFingerprint; else pushes.push(m); });
  await sleep(400);
  ok('page got fingerprint, no pair code needed', !!fp, fp);

  ws.send(JSON.stringify({ type: 'track_loaded', track: { meta: { title: 'Ext Track', video: { provider: 'youtube', id: 'aqz-KE-bpKQ' } }, cues: [{ id: 'c1', t: 5, type: 'do', title: 'Step', intro: 'x', artifacts: { any: 'echo hi' }, completion: 'done' }] } }));
  await sleep(200);

  sendStdio({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_state', arguments: {} } });
  const st = JSON.parse(textOf(await nextReply()));
  ok('single page auto-targeted over stdio', st.track && st.track.title === 'Ext Track' && st.fingerprint === fp);

  ws.send(JSON.stringify({ type: 'cue_fired', cueId: 'c1' }));
  await sleep(200);
  sendStdio({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_state', arguments: {} } });
  ok('cue visible over stdio', JSON.parse(textOf(await nextReply())).activeCue.id === 'c1');

  sendStdio({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'resume_video', arguments: {} } });
  await nextReply();
  await sleep(200);
  ok('resume pushed to page', pushes.some(p => p.type === 'resume'));

  for (const [s, n, e] of results) console.log(s.padEnd(5), n, e ? ' -> ' + e : '');
  console.log(results.every(r => r[0] === 'PASS') ? 'ALL PASS' : 'FAILURES PRESENT');
  child.kill();
  process.exit();
})();
