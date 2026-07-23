// server.js
// Docker entry point, and the smaller of the two ways to start Prompt Track.
//
// In Docker mode this process does one job: run the web server. It does NOT
// speak MCP itself. Claude Desktop instead launches a separate short lived
// process per conversation:
//
//     docker exec -i prompt-track node /app/src/stdio-bridge.js
//
// which relays MCP messages into this long running server over localhost HTTP.
// The split exists because Claude Desktop drives MCP servers by spawning a
// process and talking to its stdin and stdout, which does not fit a container
// that is already running and serving a browser. See src/stdio-bridge.js.
//
// The Claude Desktop extension does not use this file at all. There, one
// process does both jobs; see src/mcpb-main.js.

import { startServer } from './web.js';

startServer({ port: Number(process.env.PORT || 3044), mode: 'docker' });
