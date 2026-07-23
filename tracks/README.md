# Tracks

This folder is where track JSON files live. It ships empty on purpose.

A track is a single JSON file that overlays timing, cues, transitions and an AI
persona onto one or more YouTube videos. The player itself contains no track data.

To use a track:
- Drop a `.json` track file into this folder. The server serves it at
  `/tracks/<filename>.json`, so you can load it in the player by that URL.
- Or load a track from any public URL or a local file using the loader on the player
  page.

To create a track, write a JSON file following the Prompt Track schema and share it.
Anyone with the player can load and run it.

## Writing one

The authoring tool at http://localhost:3044/editor.html is the easiest way in. It
validates as you type, shows the timeline as a tree, and gives you forms for the
fiddly parts while leaving the raw JSON editable at any time.

## Shape of a track

```
{
  "meta": {
    "title":     "...",
    "videos":    [ { "key": "main", "id": "<youtube id>", "title": "..." } ],
    "timeline":  [ ...nodes... ],
    "persona":   "How Claude should speak for this track",
    "groundRules": [ "..." ],
    "references":  [ { "url": "...", "title": "...", "note": "..." } ]
  }
}
```

`meta.timeline` is a tree, not a flat list. Node types:

| Node | What it does |
|---|---|
| `clip` | Play a video from `from` to `to`. Carries nested `cues` |
| `branch` | Pause and offer the viewer a choice. Each option has its own nested timeline |
| `hold` | A pause between clips that exists purely to present one cue |
| `still` | Show an image for `hold` seconds |
| `end` | Stop |

Cue types inside a clip:

| Cue | Pauses? | For |
|---|---|---|
| `do` / `task` | Yes | A step the viewer performs |
| `checkpoint` | Yes | A verify moment |
| `quiz` | Yes | A quiz, generated live by Claude from the authored prompt |
| `note` | No | A passive on screen caption |
| `context` | No | A silent section marker. Invisible to the viewer, read by Claude |

## Two things worth understanding

**Cue timestamps are positions in the source video, not in your edited timeline.**
If your track cuts around a video, cue times will not run in ascending order.
That is expected.

**`suggestion` and `prompt` are different fields.** `suggestion` (or `copyText`)
is what the viewer sees and can copy into Claude. `prompt` is the hidden authored
instruction Claude actually runs when they do. The split is what lets a viewer ask
something short and natural while you keep full control of the behaviour behind it.

**`context` cues are the cheapest quality win.** They never appear on screen, but
they are how Claude knows what is being discussed at any moment. A track without
them still works and answers get noticeably vaguer.
