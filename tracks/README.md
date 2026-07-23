# Tracks

This folder is where track JSON files live.

A track is a single JSON file that overlays timing, cues, transitions and an AI
persona onto one or more YouTube videos. The player itself contains no track data.

## What is in here

`spaceballs2.json` is a complete working track built around the Spaceballs 2
teaser. The current build does not include this. The release ships empty. But 
you can add your scripts, or include this one, in here when you build it. 

It is the best reference for writing your own, because it uses nearly everything
the format offers against real footage: three videos cut together, four node
types, all four cue types, a nine option branch of optional scenes, a persona
with ground rules, and two hidden prompts that do real work.

## Using a track

- Drop a `.json` file into this folder. The server serves it at
  `/tracks/<filename>.json`, so you can load it in the player by that URL.
- Or load one from any public URL or a local file, using the loader on the player
  page.

A track is portable. Anyone with the player can load and run it, so a track is
worth sharing on its own.

## Writing one

The authoring tool at **http://localhost:3044/editor.html** is the easiest way in.
It validates as you type, shows the timeline as a tree, and gives you forms for
the fiddly parts while leaving the raw JSON editable at any time. There is a
**Load Example** button worth pressing at least once.

**The full schema reference is in the [main README](../README.md#track-schema-reference).**
It documents every field, every default and every node type. What follows is
orientation only.

## Shape of a track

```
{
  "meta": {
    "title":       "...",
    "videos":      [ { "key": "main", "id": "<youtube id or url>", "title": "..." } ],
    "timeline":    [ ...nodes... ],
    "persona":     "How Claude should speak for this track",
    "groundRules": [ "..." ],
    "variables":   [ { "name": "PROJECT_DIR", "prompt": "...", "default": "..." } ],
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

Cue types, sitting inside a clip's `cues` array or as a hold's single `cue`:

| Cue | Pauses? | For |
|---|---|---|
| `task` | Yes | A step the viewer performs |
| `quiz` | Yes | A quiz, generated live by Claude from the authored prompt |
| `note` | No | A passive on screen caption |
| `context` | No | A silent section marker. Invisible to the viewer, read by Claude |

`do` is accepted as an alias for `task` and normalised on load. Use `task` in new
tracks. There is no `checkpoint` type.

## Four things worth understanding

**Cue timestamps are positions in the source video, not in your edited timeline.**
If your track cuts around a video, cue times will not run in ascending order.
That is expected. A cue timed outside its clip's `from` and `to` never fires at
all, which is the single most common authoring mistake. The editor flags it.

**`suggestion` and `prompt` are different fields.** `suggestion` (or `copyText`)
is what the viewer sees and can copy into Claude. `prompt` is the hidden authored
instruction Claude actually runs when they do. The split is what lets a viewer ask
something short and natural while you keep full control of the behaviour behind it.

**`context` cues are the cheapest quality win.** They never appear on screen, but
they are how Claude knows what is being discussed at any moment. A track without
them still works and answers get noticeably vaguer. Navigation by name depends on
them too, so without any, "take me to the section about X" has nothing to match.

**Branch options are full timelines, not jump targets.** Anything you can put at
the top level goes inside an option, including further branches. That is what
makes the format a tree rather than a list.
