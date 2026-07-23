# Contributing

A guide to the code rather than to the process. It covers where things live, how
to run and build, and the handful of rules that are not obvious from reading a
single file.

## Requirements

Node 20 or later. That is the whole list for the extension path. Docker only if
you want the self-hosted route.

## Getting it running

```bash
git clone https://github.com/rilhia/prompt-track-mcp.git
cd prompt-track-mcp
npm install
npm start
```

Then open http://localhost:3044.

Files in `src/` and `public/` are served as written, so changes take effect on a
restart with no build step. `public/index.html` is not compiled, bundled or
minified: what is in the repository is what runs in the browser.

## Building the extension

```bash
node build-mcpb.mjs
```

Writes `dist/prompt-track.mcpb`. Install it by dragging it into Claude Desktop's
Settings, Extensions pane. To replace an existing install, remove the old
extension first.

`npm install` must have been run first, because `node_modules` is copied into
the bundle rather than installed on the user's machine.

The build shells out to `zip`, which is present on macOS and most Linux and
absent on stock Windows. If it fails, the script prints the alternative:

```bash
npx --yes @anthropic-ai/mcpb pack dist/stage dist/prompt-track.mcpb
```

## Running under Docker

An alternative to `npm start`, and the way to self-host on a shared machine. It
runs the web server only: Claude Desktop reaches it separately by exec-ing the
stdio bridge into the running container.

```bash
docker compose up -d --build
```

Then open http://localhost:3044.

Claude Desktop needs telling how to reach the container. Open **Settings**, then
**Developer**, then **Edit Config**, and add this inside `mcpServers`:

```json
{
  "mcpServers": {
    "prompt-track": {
      "command": "docker",
      "args": ["exec", "-i", "prompt-track", "node", "/app/src/stdio-bridge.js"]
    }
  }
}
```

Fully quit Claude Desktop (Cmd+Q on Mac, not just closing the window) and reopen
it.

The container must be running **before** Claude Desktop starts, because the
bridge execs into it. If the tools do not appear, that is almost always why:
`docker compose up -d`, then restart Claude Desktop.

To check it is up: `docker compose ps` shows the container running, and
`curl http://localhost:3044/health` returns ok.

`tracks/` is bind-mounted, so tracks can be added or edited on the host without
rebuilding. Source changes do need a rebuild: `docker compose up -d --build`. A
plain start reuses the cached image.

If you have the extension installed as well, both will try to bind port 3044.
Run one or the other, or change the port on one of them.

## Running the tests

Two scripts, covering the two transports. Both exit non-zero on failure.

```bash
# Docker transport: HTTP in on /internal-rpc, real WebSocket pages out.
PORT=3055 npm start &
node smoke.js

# Extension transport: spawns the built bundle and talks stdio to it.
node build-mcpb.mjs
mkdir -p /tmp/mcpbtest && unzip -o dist/prompt-track.mcpb -d /tmp/mcpbtest
node test-mcpb.js
```

`test-mcpb.js` is the one that catches a bundle which packs cleanly but cannot
start, so run it before cutting a release.

Two assertions in `test-mcpb.js` currently fail against working code, and both are
stale expectations rather than faults:

* `player page served` looks for the string `build v0.22 timeline`, which was
  removed from the player some versions ago.
* `stdio tools/list 7 tools` expects seven tools. There are now nine.

Worth fixing, and a good first contribution. `smoke.js` passes in full.

## Where things live

| File | What it holds |
|---|---|
| `src/mcp-core.js` | The MCP surface: tool catalogue, JSON-RPC dispatch, everything Claude sees |
| `src/web.js` | Express routes, WebSocket handling, session updates from the page |
| `src/sessions.js` | Per-page session state and the two word fingerprints |
| `src/mcpb-main.js` | Extension entry point. One process doing both stdio and web |
| `src/server.js` | Docker entry point. Web server only |
| `src/stdio-bridge.js` | Docker only. Relays MCP stdio into the running container |
| `public/index.html` | The entire player: markup, styles, logic |
| `public/editor.html` | The track authoring tool, standalone |
| `build-mcpb.mjs` | Stages and zips the `.mcpb` bundle, and writes its manifest |
| `tracks/` | Track JSON files, served at `/tracks/<name>.json` |

Each of these opens with a header comment explaining its role and how it relates
to the others. `public/index.html` has the longest one, describing the four
systems inside it, and is worth reading before changing anything in that file.

## Things that will bite you

**Never write to stdout in extension mode.** Stdout carries the MCP protocol. A
stray `console.log` anywhere reachable from `src/mcpb-main.js` corrupts the
stream and Claude Desktop drops the connection with an unhelpful error. Use
`console.error`, which is why `src/web.js` logs the way it does. `test-mcpb.js`
fails loudly if this rule is broken, which is the point of it.

**Tool descriptions are code.** The strings in the `TOOLS` array in
`src/mcp-core.js` are the only instructions Claude reads before deciding whether
to call something. Editing them changes behaviour as surely as editing a
function. They are long and emphatic on purpose.

**Cue timestamps are positions in the source video.** A track that cuts around a
video has cue times that do not run in ascending order. Anything assuming
otherwise will pick the wrong cue.

**The version number lives in four places.** `package.json`, twice in
`build-mcpb.mjs`, and `SERVER_INFO` in `src/mcp-core.js`. There is also a stale
`VERSION` in `src/web.js` used only by `/health`. Reading the version from
`package.json` in the build would remove most of this duplication and is a good
first contribution.

**The editor mirrors the player's inference rules.** `nodeType` in
`public/editor.html` reimplements the node type inference from `buildTimeline` in
`public/index.html`. If one changes, the other has to change with it, or the
editor will show authors something different from what will actually play.

## Style

No em dashes, no semicolons as sentence joiners in prose, no hyphens used as
dashes. Commas and full stops instead. This applies to comments and documentation
as well as to the README.

Comments explain why, not what. If a line needs a comment saying what it does,
the line is usually the thing to change.
