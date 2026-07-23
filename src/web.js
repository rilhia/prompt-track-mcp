// web.js
// The whole prompt-track server as an importable module, so it can run:
//   - inside Docker with the docker-exec stdio bridge (src/server.js), or
//   - inside a Claude Desktop extension where one process speaks stdio
//     directly AND serves this web layer (src/mcpb-main.js).
// Jobs: serve the player page, hold browser sessions over WebSocket,
// accept MCP JSON-RPC on /internal-rpc, expose Streamable HTTP MCP on /mcp.
//
// HOW THE PIECES CONNECT
//
//   browser page  <--WebSocket /ws-->  web.js  <--handleRpc-->  mcp-core.js
//                                        ^
//                                        | /internal-rpc (docker bridge)
//                                        | direct call    (extension)
//                                     Claude Desktop
//
// Traffic runs in both directions and the two are asymmetric:
//
//   Browser to server   status reports. The page says where playback is, which
//                       cue just fired, what the viewer answered. web.js writes
//                       these onto the session so Claude can read them later.
//
//   Server to browser   commands. A tool call in mcp-core.js pushes a pause,
//                       seek or clip down the socket via the `push` hook.
//
// EXPORTS
// startServer() is the only export. Both entry points call it and differ only in
// what they do with the returned hooks.

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  createSession, endSession, getSession, logEvent, sessionCount
} from './sessions.js';
import { handleRpc } from './mcp-core.js';
import { exec } from 'child_process';

/**
 * Best effort: snap the Claude Desktop window to the left half of the screen.
 *
 * Purely a convenience for the side by side layout the player suggests, and it
 * is allowed to fail. Every platform branch reports a human readable fallback
 * instruction instead of an error, because the viewer can always just drag the
 * window themselves and should never be blocked by this.
 *
 * Each platform needs a different mechanism:
 *   darwin  AppleScript via System Events. Needs a one time Accessibility grant
 *           for Claude, which cannot be requested from here, so the failure
 *           message explains where to give it.
 *   win32   PowerShell calling MoveWindow in user32.dll. Works silently, no
 *           permission prompt. Matches the first Claude process that owns a
 *           window, since helper processes report a zero handle.
 *   other   wmctrl, which is not installed by default on most desktops, hence
 *           the plain advice fallback.
 *
 * The 4 second timeout guards against a permission dialog or a stuck shell
 * leaving the callback hanging forever.
 *
 * @param {{x:number,y:number,w:number,h:number}} bounds Target window rectangle.
 * @param {(ok:boolean, note:string)=>void} done Called once with the outcome and
 *   a message written for the viewer, not for a log.
 */
function arrangeClaudeWindow(bounds, done) {
  const x = Number(bounds.x) || 0, y = Number(bounds.y) || 0;
  const w = Number(bounds.w) || 800, h = Number(bounds.h) || 900;
  const finish = (ok, note) => { try { done(ok, note); } catch {} };
  const timeoutMs = 4000;
  if (process.platform === 'darwin') {
    const script = 'tell application "System Events" to tell (first process whose name contains "Claude") to set position of front window to {' + x + ', ' + y + '}\n' +
      'tell application "System Events" to tell (first process whose name contains "Claude") to set size of front window to {' + w + ', ' + h + '}';
    exec('osascript -e ' + JSON.stringify(script), { timeout: timeoutMs }, (err) => {
      if (err) finish(false, 'macOS needs permission to move windows. Allow Claude under System Settings, Privacy and Security, Accessibility, or just drag Claude to the left half (hold the green button and pick Tile Window to Left of Screen).');
      else finish(true, 'Claude Desktop snapped to the left half.');
    });
  } else if (process.platform === 'win32') {
    const ps = "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool MoveWindow(System.IntPtr h,int x,int y,int w,int hh,bool r);';" +
      '$p=Get-Process | Where-Object {$_.ProcessName -like "*Claude*" -and $_.MainWindowHandle -ne 0} | Select-Object -First 1;' +
      'if($p){[U.W]::MoveWindow($p.MainWindowHandle,' + x + ',' + y + ',' + w + ',' + h + ',$true)}else{exit 1}';
    exec('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"', { timeout: timeoutMs }, (err) => {
      if (err) finish(false, 'Could not find the Claude window to move. Snap it manually with Win + Left Arrow.');
      else finish(true, 'Claude Desktop snapped to the left half.');
    });
  } else {
    exec('wmctrl -r Claude -e 0,' + x + ',' + y + ',' + w + ',' + h, { timeout: timeoutMs }, (err) => {
      if (err) finish(false, 'Automatic arranging is not available on this system. Snap Claude to the left half with your window manager.');
      else finish(true, 'Claude window snapped to the left half.');
    });
  }
}

// ES modules have no __dirname, so it is derived from import.meta.url. Needed to
// resolve ../public and ../tracks regardless of the working directory the server
// was started from, which differs between Docker, the extension and npm start.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reported by /health only.
// NOTE: this is stale and does not track the released version. The authoritative
// version numbers live in package.json, build-mcpb.mjs and mcp-core.js
// (SERVER_INFO). Worth folding all four into one source before the next release.
const VERSION = '0.22.0';

/**
 * Build and start the server. Both entry points funnel through here.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port=3044] Port for the player page and all HTTP routes.
 * @param {string}  [opts.mode='docker'] 'docker' or 'mcpb'. Reported to the page
 *   in the hello frame and by /health. Affects presentation only, never routing.
 * @returns {{hooks:{push:Function}, server:import('http').Server}}
 *   `hooks.push` is how mcp-core.js reaches a browser page; `server` is the raw
 *   HTTP server, exposed for tests and shutdown.
 */
export function startServer({ port = Number(process.env.PORT || 3044), mode = 'docker' } = {}) {
  // Logs go to stderr, always. In extension mode stdout carries the MCP protocol
  // and any stray write to it corrupts the stream. See src/mcpb-main.js.
  const log = (...a) => console.error('[prompt-track]', ...a);

  const app = express();
  // 2mb covers a large track posted whole. Tracks are text, so this is generous.
  app.use(express.json({ limit: '2mb' }));
  // The player page and the authoring editor, served as static files. There is no
  // build step: public/index.html is shipped exactly as it is written.
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Track sidecars, so the page can fetch one by URL.
  app.use('/tracks', express.static(path.join(__dirname, '..', 'tracks')));

  app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessionCount(), version: VERSION, mode }));

  // ---- push helper: server -> a specific browser page ------------------

  /**
   * Send a command frame to one player page.
   *
   * Re-reads the session by id rather than trusting the object passed in. A tool
   * call may hold a session captured moments earlier, and the viewer can close
   * the tab in between; looking it up again means a closed page is a quiet false
   * rather than a throw on a dead socket. readyState 1 is OPEN.
   *
   * @param {object} session
   * @param {object} message Frame the page understands, e.g. {type:'seek', ...}.
   * @returns {boolean} True if it went out, false if the page had gone.
   */
  function push(session, message) {
    const live = getSession(session.id);
    if (!live || !live.ws || live.ws.readyState !== 1) return false;
    live.ws.send(JSON.stringify(message));
    return true;
  }

  const hooks = { push };

  // ---- MCP over internal RPC (used by the docker stdio bridge) ----------
  // Only reachable from inside the container, where the bridge runs. The header
  // check is a sanity guard against stray localhost posts, not authentication.
  // A null result means the message was a notification and gets 202 with no body,
  // which the bridge understands as "write nothing back".
  app.post('/internal-rpc', async (req, res) => {
    const mcpKey = req.header('x-bridge-key');
    if (!mcpKey) return res.status(400).json({ error: 'missing x-bridge-key header' });
    const response = await handleRpc('stdio:' + mcpKey, req.body, hooks);
    if (response === null) return res.status(202).end();
    res.json(response);
  });

  // ---- MCP over Streamable HTTP (for future hosted use) -----------------
  // Implements the MCP Streamable HTTP transport so a remote client could connect
  // without the stdio bridge. Unused by both shipping paths today, kept because it
  // is the route a hosted Prompt Track would take.
  //
  // Sessions here are transport level and unrelated to player sessions: this Map
  // only tracks which Mcp-Session-Id values were issued by initialize, so later
  // requests can be rejected if they never handshook. The value is unused.
  const httpMcpKeys = new Map();
  app.post('/mcp', async (req, res) => {
    let sid = req.header('mcp-session-id');
    const isInit = req.body && req.body.method === 'initialize';
    if (isInit) {
      sid = crypto.randomUUID();
      httpMcpKeys.set(sid, true);
      res.setHeader('Mcp-Session-Id', sid);
    } else if (!sid || !httpMcpKeys.has(sid)) {
      return res.status(400).json({ jsonrpc: '2.0', id: req.body && req.body.id, error: { code: -32000, message: 'Missing or unknown Mcp-Session-Id. Initialize first.' } });
    }
    const response = await handleRpc('http:' + sid, req.body, hooks);
    if (response === null) return res.status(202).end();
    res.json(response);
  });
  app.delete('/mcp', (req, res) => {
    const sid = req.header('mcp-session-id');
    if (sid) httpMcpKeys.delete(sid);
    res.status(204).end();
  });

  // ---- WebSocket: the player pages --------------------------------------
  // Shares the HTTP server so page and socket live on one port, which keeps the
  // extension to a single user-visible port number.
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // One session per connection. A page refresh is a new session with a new
    // fingerprint; nothing is carried over. See src/sessions.js.
    const session = createSession(ws);
    // First frame out. The page displays the fingerprint and adapts its wording
    // to the mode.
    ws.send(JSON.stringify({ type: 'hello', sessionFingerprint: session.fingerprint, mode }));

    // Inbound frames are status reports from the page. Each one updates the
    // session so a later get_state can describe where the viewer actually is.
    // Unknown types fall through the switch and are ignored, which lets a newer
    // player page talk to an older server without breaking.
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Re-read: the socket can be mid-close while a frame is still being handled.
      const s = getSession(session.id);
      if (!s) return;

      switch (msg.type) {
        // The page loaded a track. Cue progress resets: a different track means
        // the old fired/active ids refer to cues that no longer exist.
        case 'track_loaded':
          // Shape checked before storing, since every MCP tool assumes meta and
          // a cues array are present once session.track is non-null.
          if (msg.track && msg.track.meta && Array.isArray(msg.track.cues)) {
            s.track = msg.track;
            s.firedCueIds = [];
            s.activeCueId = null;
            logEvent(s, 'track_loaded', { title: msg.track.meta.title, cues: msg.track.cues.length });
          }
          break;
        // Heartbeat from the page, sent on a timer and on state changes. This is
        // the single source of truth for "where is the viewer right now".
        case 'playback':
          s.playback = { time: Number(msg.time) || 0, state: String(msg.state || 'unknown'), video: msg.video || null };
          break;
        // A cue reached its timestamp and took the floor. firedCueIds is what
        // stops it firing again on a rewind; the player re-arms it explicitly
        // (see cue_rearmed) once playback moves far enough back.
        case 'cue_fired':
          s.activeCueId = msg.cueId;
          if (!s.firedCueIds.includes(msg.cueId)) s.firedCueIds.push(msg.cueId);
          logEvent(s, 'cue_fired', { cueId: msg.cueId, at: Math.floor(s.playback.time) });
          break;
        // The floor was released, either by the viewer pressing the button on the
        // page or by Claude calling resume_video. `via` records which, which is
        // useful when reading a log to see how much help the viewer needed.
        case 'cue_completed':
          logEvent(s, 'cue_completed', { cueId: s.activeCueId, via: msg.via || 'page' });
          s.activeCueId = null;
          break;
        // The viewer scrubbed back before a cue, so it becomes eligible to fire
        // again. Without this a rewatch would silently skip every cue already seen.
        case 'cue_rearmed':
          s.firedCueIds = s.firedCueIds.filter(idc => idc !== msg.cueId);
          if (s.activeCueId === msg.cueId) s.activeCueId = null;
          logEvent(s, 'cue_rearmed', { cueId: msg.cueId });
          break;
        // Answers to the calibration questions. Merged rather than replaced so a
        // later partial update cannot blank a field that was already answered.
        case 'learner':
          s.learner = { os: msg.os || s.learner.os, comfort: msg.comfort || s.learner.comfort };
          logEvent(s, 'learner_calibrated', { ...s.learner });
          break;
        // Viewer supplied values substituted into {{PLACEHOLDERS}} in code
        // artifacts. Accumulated across the session, so each frame need only
        // carry what changed.
        case 'variables':
          if (msg.variables && typeof msg.variables === 'object') {
            s.variables = { ...s.variables, ...msg.variables };
            logEvent(s, 'variables_set', { names: Object.keys(msg.variables) });
          }
          break;
        // Viewer expanded the optional detail on a cue card. Recorded purely as a
        // signal of engagement for Claude to read; nothing acts on it.
        case 'deeper_opened':
          logEvent(s, 'deeper_opened', { cueId: msg.cueId });
          break;
        // The one inbound frame that triggers an action rather than storing state.
        // Result is pushed back so the page can tell the viewer what happened,
        // including the manual fallback when the OS refused.
        case 'arrange_windows': {
          arrangeClaudeWindow(msg.bounds || {}, (ok, note) => {
            push(s, { type: 'arranged', ok, note });
            logEvent(s, 'arrange_windows', { ok });
          });
          break;
        }
      }
    });

    // Tab closed or refreshed. The session and its log go with it.
    ws.on('close', () => endSession(session.id));
  });

  server.listen(port, () => log('listening on http://localhost:' + port + ' (mode: ' + mode + ')'));

  return { hooks, server };
}
