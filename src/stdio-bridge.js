// stdio-bridge.js
// Docker mode only. Claude Desktop launches this via:
//   docker exec -i prompt-track node /app/src/stdio-bridge.js
// It speaks MCP stdio on stdin/stdout and relays each message to the long
// running server in this container over localhost HTTP. Never write anything
// except protocol JSON to stdout. Diagnostics go to stderr.
//
// WHY A BRIDGE AT ALL
// Claude Desktop expects to own the lifetime of an MCP server: it spawns a
// process, writes requests to its stdin and reads replies from its stdout. A
// Docker container serving a browser is the opposite shape, already running and
// shared by every conversation. This file reconciles the two. It is spawned per
// conversation, is stateless, holds no session data, and does nothing but
// translate between the two transports. All real work happens in the server.
//
//     Claude Desktop --stdio--> stdio-bridge --HTTP--> web.js /internal-rpc
//
// Extension users never run this. See src/mcpb-main.js for that path.

import http from 'http';
import crypto from 'crypto';
import readline from 'readline';

const PORT = Number(process.env.PORT || 3044);

// Identifies this bridge instance to the server. /internal-rpc requires the
// header to be present, which keeps stray localhost requests from being treated
// as MCP traffic. It is not a secret: the endpoint is only reachable from inside
// the container, so this is a sanity check rather than an access control.
const BRIDGE_KEY = crypto.randomUUID();

/**
 * Forward one MCP message to the server and resolve with its reply.
 *
 * Never rejects. A failed relay resolves to a JSON-RPC error object the model can
 * actually read, because a rejected promise here would surface to the user as a
 * dead connection with no explanation. Notifications, which carry no id, resolve
 * to null instead so that nothing is written back.
 *
 * @param {object} message A parsed JSON-RPC message from Claude Desktop.
 * @returns {Promise<object|null>} The reply to write to stdout, or null.
 */
function relay(message) {
  return new Promise((resolve) => {
    const body = JSON.stringify(message);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/internal-rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-bridge-key': BRIDGE_KEY } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // 202 is how the server says "that was a notification, no reply".
          if (res.statusCode === 202 || !data) return resolve(null);
          // An unparseable body is treated as no reply rather than being passed
          // through, since writing malformed JSON to stdout breaks the stream.
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    // Almost always means the container is up (this process is running inside it)
    // but the server within it is not listening. The remedy is in the message.
    req.on('error', (err) => {
      process.stderr.write('[bridge] relay error: ' + err.message + '\n');
      if (message.id !== undefined && message.id !== null) {
        resolve({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Prompt Track server unreachable inside the container. Is it running? Try: docker compose up -d' } });
      } else resolve(null);
    });
    req.write(body);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Same deferred exit as mcpb-main.js: stdin closing means Claude Desktop is done
// sending, but in-flight relays still owe a reply on stdout.
let pending = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && pending === 0) process.exit(0); }

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch {
    process.stderr.write('[bridge] unparseable line ignored\n');
    return;
  }
  pending++;
  const response = await relay(msg);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
  pending--;
  maybeExit();
});

rl.on('close', () => { stdinClosed = true; maybeExit(); });
