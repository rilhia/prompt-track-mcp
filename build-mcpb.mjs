// build-mcpb.mjs — stages and packs the Claude Desktop extension.
//   node build-mcpb.mjs
// Produces dist/prompt-track.mcpb, a one-click install for Claude Desktop.
// Requires dependencies installed (npm install) and the UI built (it runs
// build-ui.mjs itself if the bundle is missing).
//
// WHAT AN .mcpb ACTUALLY IS
// A zip archive with a manifest.json at its root and everything the server needs
// beside it. Claude Desktop unpacks it, reads the manifest, and launches the
// declared entry point using its own bundled Node runtime. That is why the user
// needs neither Node nor Docker: the runtime comes with Claude Desktop and the
// dependencies are inside the bundle.
//
// The consequence is that npm install must have been run before building, since
// node_modules is copied wholesale into the bundle rather than fetched later.
//
// WHAT THIS SCRIPT DOES
//   1. wipe dist/ and create a staging tree
//   2. write manifest.json describing the extension to Claude Desktop
//   3. write a tiny server/index.js shim that imports the real entry point
//   4. copy src, public, tracks and node_modules into the stage
//   5. delete things the runtime does not need (see the prune list below)
//   6. zip the stage into dist/prompt-track.mcpb
//
// PREREQUISITE: `zip` on PATH. Present on macOS and most Linux, absent on stock
// Windows, where the npx fallback printed on failure is the way through.
//
// VERSION NUMBERS ARE DUPLICATED. The version appears here (twice), in
// package.json, and in SERVER_INFO in src/mcp-core.js, and they are kept in step
// by hand. Reading it from package.json here would remove two of the four copies.

import { execSync } from 'child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';

// Everything is assembled here and then zipped. Removed afterwards, so dist/
// holds only the finished bundle.
const stage = 'dist/stage';
rmSync('dist', { recursive: true, force: true });
mkdirSync(stage + '/server', { recursive: true });

// The manifest Claude Desktop reads to install and launch the extension. Written
// here rather than kept as a file so the build has one source for the version and
// the staged tree cannot drift from a checked-in copy.
const manifest = {
  manifest_version: '0.2',
  name: 'prompt-track',
  display_name: 'Prompt Track',
  version: '0.70.0',
  description: 'A caption track for doing, not just watching. Tutorial videos that pause at authored cues while Claude coaches you through each step. After installing, open http://localhost:3044 in your browser.',
  long_description: 'Prompt Track attaches a timestamped sidecar of creator authored cues to an ordinary tutorial video. In lab mode the video pauses itself at each cue and hands you the exact step, personalised to your machine, while Claude acts as your companion: it sees exactly where you are, adapts code on request, and resumes the video when you are done. Install this extension, then open http://localhost:3044, press Copy the Claude starter, and paste it into this chat.',
  author: { name: 'Richard Hall', url: 'https://rilhia.com' },
  repository: { type: 'git', url: 'https://github.com/rilhia/prompt-track-mcp' },
  license: 'MIT',
  keywords: ['tutorial', 'video', 'learning', 'developer-advocacy', 'documentation'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      // ${__dirname} is substituted by Claude Desktop at launch with the path it
      // unpacked the bundle to, which is not knowable at build time.
      args: ['${__dirname}/server/index.js'],
      // The port the user chose in the extension settings, passed to the server
      // as an environment variable. src/mcpb-main.js reads it.
      env: { PORT: '${user_config.port}' }
    }
  },
  // Surfaced as a settings field in Claude Desktop. The only thing a user can
  // configure, and only needed when something else already holds 3044.
  user_config: {
    port: {
      type: 'string',
      title: 'Web player port',
      description: 'The localhost port for the player page. Change only if 3044 is already in use on your machine.',
      default: '3044',
      required: false
    }
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    // Node 20+ for the language features used across src/.
    runtimes: { node: '>=20' }
  }
};

writeFileSync(stage + '/manifest.json', JSON.stringify(manifest, null, 2));

// The declared entry point, kept to a single import so the manifest can name a
// stable path while the real logic stays in src/ where it is developed and read.
writeFileSync(stage + '/server/index.js',
  "import './src/mcpb-main.js';\n");

// Marks the staged server as an ES module. Without type:'module' Node treats the
// .js files as CommonJS and every import statement in src/ fails at launch.
writeFileSync(stage + '/server/package.json', JSON.stringify({
  name: 'prompt-track-server', version: '0.70.0', type: 'module', private: true
}, null, 2));

// Everything the running server touches. node_modules is copied rather than
// installed at the far end because the user's machine may have no npm at all.
for (const dir of ['src', 'public', 'tracks', 'node_modules']) {
  cpSync(dir, stage + '/server/' + dir, { recursive: true });
}
// Prune the stage. Everything here is either a build-time dependency with no role
// at runtime, or a platform-specific binary that would bloat the bundle and could
// not run on a different machine anyway. The MCP SDK goes too: src/mcp-core.js
// implements the protocol directly rather than depending on it.
//
// force:true throughout, so a path already absent is not an error. That keeps the
// build working whether or not the optional dev dependencies were installed.
rmSync(stage + '/server/node_modules/.bin', { recursive: true, force: true });
rmSync(stage + '/server/node_modules/esbuild', { recursive: true, force: true });
rmSync(stage + '/server/node_modules/@esbuild', { recursive: true, force: true });
rmSync(stage + '/server/node_modules/@modelcontextprotocol', { recursive: true, force: true });
// Leftovers from the abandoned bundled-UI approach. public/ is shipped as-is now.
rmSync(stage + '/server/src/ui', { recursive: true, force: true });
rmSync(stage + '/server/src/generated', { recursive: true, force: true });

// Zip the stage from inside it, so paths in the archive are relative to the
// bundle root and manifest.json lands at the top level where Claude Desktop
// expects it. Zipping the directory from outside would nest everything one level
// down and the extension would fail to install.
try {
  execSync('cd ' + stage + ' && zip -rq ../prompt-track.mcpb .', { stdio: 'inherit', shell: '/bin/sh' });
} catch (e) {
  console.error('[build-mcpb] zip failed. Alternative: npx --yes @anthropic-ai/mcpb pack ' + stage + ' dist/prompt-track.mcpb');
  process.exit(1);
}
// Stage removed so dist/ contains only the artifact worth uploading.
rmSync(stage, { recursive: true, force: true });
console.log('[build-mcpb] wrote dist/prompt-track.mcpb');
