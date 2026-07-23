# Prompt Track (MCP edition)

**A caption track for doing, not just watching. Now with Claude Desktop as the companion, no API key anywhere.**

A prompt track is a timestamped sidecar file of creator authored cues attached to an ordinary video, toggleable like captions. In lab mode the video pauses itself at each cue and the page hands you the exact step from the creator's ground truth. You do all the work. And when you have a question, you ask Claude, which is paired to your exact session and checks where you are before answering.

See one, do one, teach one. The video is the see one. The track is the do one. The track being a plain text file in a repository is the teach one.

## What runs where

One Docker container runs a single Node server doing four jobs: it serves the player page, holds every browser session over WebSocket, exposes the MCP tools, and relays control between Claude and your video. Claude Desktop connects to it through a thin stdio bridge using `docker exec` into the running container. Your browser and Claude both talk to the same server, and a short pair code spoken once links your tab to your conversation.

```
Browser tab  <--WebSocket-->  prompt-track server (Docker)  <--stdio bridge-->  Claude Desktop
```

No API key. No cloud account beyond your normal Claude Desktop login, including the free plan.

## Prerequisites

* **Docker** (Docker Desktop on Mac or Windows).
* **Claude Desktop**, any plan.

## Run it

There are two ways to run Prompt Track. The extension is the friendly one. Docker is for developers and self hosting.

### The easy way: install it as a Claude Desktop extension

One file, no terminal, no Docker, no config editing.

1. Download `prompt-track.mcpb` from this repository's releases.
2. Open Claude Desktop, go to Settings, then Extensions, and drag the file in (or use Advanced settings, Install Extension).
3. Click Install.
4. Open **http://localhost:3044** in your browser.

That is the whole setup. Claude Desktop runs the server itself using its built in runtime, so the player page and the Claude tools come alive together whenever Claude Desktop is open. There is nothing to connect and nothing to pair: the page and Claude already share the same server on your machine. The page shows its two word name at the top (for example fox amber), which only matters if you open several player pages at once, in which case Claude will ask which one you mean.

If port 3044 is taken on your machine, the extension's settings let you change it.

To build the bundle yourself: `npm install && node build-mcpb.mjs` produces `dist/prompt-track.mcpb`. See [CONTRIBUTING.md](CONTRIBUTING.md) for working on the code.

### The developer way: Docker

```bash
git clone https://github.com/rilhia/prompt-track-mcp.git
cd prompt-track-mcp
docker compose up -d --build
```

Then open **http://localhost:3044** in your browser. The player loads with the sample track and shows a pair code.

To check it is running: `docker compose ps` should show the `prompt-track` container up, and `curl http://localhost:3044/health` should return ok.

## Connect Claude Desktop (one time)

Claude Desktop is configured by `claude_desktop_config.json`. The easiest way to open it is Claude Desktop, then Settings, then Developer, then Edit Config. Add this inside `mcpServers` (if the section already exists, add just the `"prompt-track"` block inside it):

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

Fully quit Claude Desktop (Cmd + Q on Mac, not just closing the window) and open it again. You should now see **prompt-track** in the tools menu with six tools.

Note the container must be running before Claude Desktop can connect, because the bridge execs into it. Start it with `docker compose up -d` first.

## Use it

1. Open http://localhost:3044, answer the two calibration questions, and press play.
2. At each diamond on the rail the video pauses itself and the step appears on the page: the notes, the code personalised to your values, a deeper explanation behind a click.
3. Ask your questions in Claude, in its own window, in plain language. "What step am I on?" "Why does this command use that flag?" "Adapt this code to write JSON instead." Claude checks your exact state before answering, knows the whole track, and never has to be set up or told where you are.
4. Tell Claude when a step is done and it resumes the video, or press the button on the page. Both work.

Press Side by side with Claude on the page and it arranges your screen: the player takes the right half and the server makes a best effort to snap Claude Desktop to the left (on a Mac this may ask once for permission to move windows, and if declined the page shows the manual shortcut instead).

## The tools Claude gets

| Tool | What it does |
|------|--------------|
| `get_state` | The current moment: active cue in full, playback position, done list, learner calibration and variables |
| `get_track` | The entire track: metadata, ground rules, every cue, all code |
| `resume_video` | Resumes playback, releasing the active cue |
| `pause_video` | Pauses playback |
| `seek_video` | Jumps to a time in seconds, optionally in another video of the track |
| `play_clip` | Plays a bounded clip from any video in the track, then returns the viewer or pauses |

All tools take an optional `session` argument, the two word name shown on the page, needed only when several player pages are open at once. With one page open, Claude targets it automatically. The design principle throughout: the page delivers the authored content and controls the video, and Claude answers questions on demand, grounded in `get_state` before every answer. Nothing listens, nothing loops, nothing needs pairing.

## Write a track for your own video

Tracks live in the `tracks/` folder, which is mounted into the container, so you can add or edit tracks without rebuilding. Drop `my-track.json` in there and load it in the player as `/tracks/my-track.json`.

```json
{
  "meta": {
    "title": "Install MyTool from scratch",
    "video": { "provider": "youtube", "id": "YOUR_VIDEO_ID_OR_FULL_URL" },
    "persona": "How the companion should behave.",
    "groundRules": ["Only state facts present in this track.", "The learner types every command themselves."]
  },
  "cues": [
    {
      "id": "cue-1",
      "t": 132,
      "type": "do",
      "title": "Start the stack",
      "intro": "What the page shows when the video pauses here.",
      "artifacts": { "mac": "docker compose up -d --build", "windows": "docker compose up -d --build", "any": "docker compose up -d --build" },
      "deeper": "The held in reserve explanation for anyone who asks why.",
      "completion": "What done looks like, so Claude knows when to resume."
    }
  ]
}
```

`t` is seconds. `type` is one of three:

| Type | Pauses the video? | What it is for |
|------|-------------------|----------------|
| `do` | Yes | A step the learner performs. The card shows the notes and the personalised code, and `completion` tells Claude what finished looks like |
| `checkpoint` | Yes | A verify moment. The learner confirms their state matches the video, and Claude judges pasted output against `completion` |
| `context` | No | A silent section marker. It names what the video is about from this timestamp on, appears as a small dot on the rail (click to jump), keeps Claude aware of the current section, and powers navigation |
| `branch` | Yes | A choice point. The card offers jumps into other moments or other videos of the track as bounded clips, and the player returns automatically when a clip ends |

### Multiple videos and clips

A track can span several videos. Declare them in `meta.videos` and give each cue a `video` key (cues without one belong to the first video):

```json
"meta": {
  "videos": [
    { "key": "teaser", "id": "iXBLxUWwoMY", "title": "The teaser" },
    { "key": "original", "id": "qAGuYr3hpR4", "title": "The 1987 film" }
  ]
}
```

A `branch` cue pauses and offers choices, each a bounded clip: a video key, a start `t`, an `until`, and optionally a `then` target. Without `then`, the player returns to just after the branch point when the clip ends, so a viewer can hop to a moment in a different video and land back where they were:

```json
{
  "id": "branch-1", "t": 20, "video": "teaser", "type": "branch",
  "title": "See the original moment",
  "intro": "This gag calls back to the original. Watch it?",
  "choices": [
    { "label": "Ludicrous Speed", "video": "original", "t": 3300, "until": 3390 }
  ]
}
```

Claude can drive the same machinery on request through the `play_clip` tool ("show me the combing the desert scene"), reading the available videos, sections and authored clips from `get_track`, and returning the viewer to their current position afterwards. See `tracks/spaceballs-track.json` for a complete two video example (its clip timestamps are placeholders to set against the real upload).

Context cues can carry an optional `topics` array of keywords. Together with the title and notes, these make the video searchable through Claude: ask "take me to the section about JavaScript" and Claude reads the track, shortlists matching sections, asks which you meant, and jumps the video there paused and ready to play. The `video.id` field accepts a bare 11 character YouTube ID or a full pasted URL in any shape. The video must allow embedding (your own uploads do by default).

## Multi user

Every browser tab is its own session with its own code, state and history. Many people can use one server at once, each pairing their own Claude to their own tab. The server also exposes the same MCP over Streamable HTTP at `/mcp`, so the identical codebase can later be hosted publicly and added to Claude as a custom connector, no code changes.

## Troubleshooting

**Claude Desktop shows no prompt-track tools.** The container was not running when Claude Desktop started. Run `docker compose up -d`, then fully quit and reopen Claude Desktop.

**Claude says no player page is open.** The tab was closed or refreshed, or the page cannot reach the server. Open http://localhost:3044 and ask again.

**Claude asks which page you mean.** You have more than one player page open. Each shows its two word name at the top, just tell Claude that name.

**The video pane says refused to connect.** A privacy extension or ad blocker on your browser is blocking YouTube embeds. The player already uses the privacy enhanced youtube-nocookie domain, which most blockers allow. If yours still objects, allow this site in the extension, or test in a private window.

**Only some tools show up in Claude.** In Claude Desktop's connector menu, set tool access to "Tools already loaded" rather than "Load tools when needed".

**After updating the code.** Rebuild with `docker compose up -d --build`. A plain start can reuse an old cached image.

## Working on the code

[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, the build, the tests, and
the handful of rules that are not obvious from any single file. Every source file
opens with a header comment explaining its role; `public/index.html` describes the
four systems inside it and is the one to read first if you are changing the player.

## License

MIT. If you build a track for a real tutorial, I would genuinely love to see it.
