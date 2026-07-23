// mcpb-main.js
// Claude Desktop extension entry point, and the path almost every user takes.
//
// One process, two faces: it speaks MCP over stdio to Claude Desktop directly
// (newline delimited JSON-RPC on stdin and stdout), and it runs the full web
// server so the viewer's browser gets the player page from the same process.
// No Docker, no bridge, nothing for the user to install or configure.
//
// STDOUT IS THE PROTOCOL CHANNEL. Anything written to stdout that is not a
// JSON-RPC message will corrupt the stream and Claude Desktop will drop the
// connection, usually with an unhelpful error. Every diagnostic in this file and
// everything reachable from it must go to stderr instead. This is why web.js
// logs through console.error rather than console.log.

import readline from 'readline';
import crypto from 'crypto';
import { startServer } from './web.js';
import { handleRpc } from './mcp-core.js';

// Port comes from the extension's user_config (see build-mcpb.mjs), defaulting
// to 3044. The viewer only changes it if something else already holds that port.
const PORT = Number(process.env.PORT || 3044);

// Start the web layer first and keep its hooks: they are how a tool call reaches
// a browser page to push a pause, seek or clip command.
const { hooks } = startServer({ port: PORT, mode: 'mcpb' });

// Identifies this MCP connection. Currently informational, since tool calls are
// routed to browser pages by fingerprint rather than by which client asked.
const MCP_KEY = 'stdio:mcpb-' + crypto.randomUUID();

// Read stdin line by line. terminal:false stops readline treating the stream as
// an interactive TTY, which would mangle the protocol.
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Graceful shutdown bookkeeping. Claude Desktop signals that it is finished by
// closing stdin, but requests already in flight still deserve their replies, so
// exit is deferred until stdin is closed AND nothing is outstanding. Exiting on
// close alone would truncate the last response of every session.
let pending = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && pending === 0) process.exit(0); }

// One JSON-RPC message per line, in, handled, and back out on stdout.
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch {
    // Skip rather than crash: one malformed line should not take down a session
    // that is otherwise healthy.
    process.stderr.write('[prompt-track] unparseable stdio line ignored\n');
    return;
  }
  pending++;
  try {
    // handleRpc returns null for notifications, which by JSON-RPC rules get no
    // reply at all. Writing anything for those would desynchronise the stream.
    const response = await handleRpc(MCP_KEY, msg, hooks);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err) {
    process.stderr.write('[prompt-track] rpc error: ' + (err && err.message) + '\n');
  }
  pending--;
  maybeExit();
});

rl.on('close', () => { stdinClosed = true; maybeExit(); });
