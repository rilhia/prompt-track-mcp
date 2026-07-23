// mcp-core.js
// A deliberately small MCP implementation: initialize, tools/list, tools/call,
// ping, and the MCP Apps resource. Five pull-only tools. The user asks Claude,
// Claude reads the state. No pairing, no listening loops, no push into chat.
//
// WHAT THIS MODULE IS
// The MCP surface Claude sees. It owns the tool catalogue, the JSON-RPC dispatch
// and the shaping of everything handed to the model. It is transport agnostic:
// handleRpc takes a parsed message and returns a reply, so the same code serves
// the extension (direct call), the Docker bridge (over HTTP) and the Streamable
// HTTP endpoint without knowing which is which.
//
// PULL, NOT PUSH
// Nothing here initiates. Every tool runs because the viewer said something and
// Claude reached for it. The server cannot interrupt a conversation, and the
// player page cannot make Claude speak. That constraint is why get_state carries
// so much context: it is the single moment where Claude gets to find out what
// has been happening, so it has to answer everything at once.
//
// TOOL DESCRIPTIONS ARE THE REAL INTERFACE
// The description strings below are unusually long and emphatic, and that is
// deliberate rather than untidy. They are the only instructions the model reads
// before deciding whether to call a tool, so behaviour that would be a code
// comment in a normal library has to be stated in prose here instead. Editing
// them changes runtime behaviour as surely as editing the functions does. In
// particular the shouting in activate_prompt and get_state exists because those
// two are easy for a model to skip when the viewer's request looks answerable
// without them, and skipping them produces a confident answer with no grounding.
//
// TERMINOLOGY
// "Viewer" and "learner" both appear, in the tool text and in the code. They mean
// the same person: whoever is watching the video. The mixture is historical, from
// the project starting as a tutorial tool and widening to any video.
//
// EXPORTS
//   callTool(mcpKey, name, args, hooks)  run one tool, return MCP content
//   handleRpc(mcpKey, msg, hooks)        dispatch one JSON-RPC message

import { listSessions, findByFingerprint, logEvent } from './sessions.js';

// Echoed back only when a client omits protocolVersion during initialize.
const PROTOCOL_FALLBACK = '2025-03-26';

// Shown in Claude Desktop's server list. Kept in step with package.json and the
// manifest in build-mcpb.mjs by hand at present.
const SERVER_INFO = { name: 'prompt-track', version: '0.70.0' };

// Spread into every tool's schema. Optional by design: with one page open the
// server picks it, and only genuine ambiguity makes Claude ask. See
// resolveSession for the branch this feeds.
const SESSION_PARAM = {
  session: {
    type: 'string',
    description: 'Optional. Only needed when more than one player page is open. Give the fingerprint shown at the top of the page the user means, for example "fox amber".'
  }
};

/**
 * The tool catalogue, returned verbatim by tools/list.
 *
 * Roughly three groups:
 *   reading      get_state, get_track, get_references
 *   authored     activate_prompt
 *   controlling  resume_video, pause_video, seek_video, play_clip, go_to
 *
 * The header comment on this file explains why the descriptions are written the
 * way they are. Treat them as code.
 */
const TOOLS = [
  // The hidden-prompt mechanism, and the one tool a model is most likely to skip.
  // A track author can attach a `prompt` to a task or quiz cue: the viewer sees a
  // friendly suggestion ("quiz me on this section") while the real instructions
  // stay hidden in the track. Answering the visible wording alone throws away the
  // author's intent entirely, hence the insistence on calling this first.
  {
    name: 'activate_prompt',
    description:
      'ALWAYS call this FIRST, before answering, whenever the viewer asks something that could be a track task or quiz, OR whenever their message contains the marker [prompt-track]. This is how authored prompts reach you: the track hides an author "prompt" on task and quiz cues, and you must run it rather than answering from the plain request. Give the viewer\'s message as `query`; the server matches it to the nearest task/quiz cue and returns that cue\'s authored prompt plus a directive to follow. If it returns a prompt, follow it exactly and in the track persona. If the returned prompt asks for details (names, dates, a recipient), you MUST interview the viewer one question at a time and wait for their answers BEFORE producing the final output (e.g. a letter): never fill blanks with placeholders or invented values when you could ask. If no cue matches, the tool says so and you may answer normally.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The viewer\'s message or the question they copied, verbatim.' },
        ...SESSION_PARAM
      },
      required: ['query']
    }
  },
  // Author-vetted sources. Prompt Track cannot browse, so this hands Claude the
  // URLs and tells it to read them with its own browsing rather than answering
  // about the video's subject matter from memory.
  {
    name: 'get_references',
    description:
      'Returns the author-vetted reference sources for this track: the global sources (meta.references) and any attached to individual cues, each with a url, optional title and note. These are curated pages about the video\'s content (facts, background, trivia). When the viewer asks something a source could answer, READ the relevant url(s) with your own web browsing and answer from them with citations, rather than guessing. get_state already includes the sources relevant to the current moment; call this for the complete list across the whole track.',
    inputSchema: { type: 'object', properties: { ...SESSION_PARAM } }
  },
  // The main one. Called before every reply, and returns everything about the
  // current moment: persona, position, active cue, viewer answers, recent events.
  {
    name: 'get_state',
    description:
      'Call this before answering ANY message from the viewer, every time, so your reply matches where they are AND so you adopt the track persona. Returns a personaDirective you MUST obey (speak as that character in every reply, including small talk and off-topic chat), the current playback position, which cue is holding the floor with its full content, which cues are done, the viewer\'s stated OS, comfort and variables, and a short event log. Ground yourself in this and stay in persona. Never invent commands, paths or settings that are not in the track.',
    inputSchema: { type: 'object', properties: { ...SESSION_PARAM } }
  },
  // The whole track, for questions that reach beyond the current moment: what is
  // coming up, what was covered earlier, and navigation by name.
  {
    name: 'get_track',
    description:
      'Returns the entire loaded track: metadata, persona, ground rules and every cue in full. Cue types: "context" cues are a SILENT knowledge layer (title, intro, topics) describing what is on screen at their timestamp, not shown to the viewer, for you to ground answers in. "note" cues are passive on-screen captions. "task"/"do" cues ask the viewer to do something and may carry code artifacts and/or a "prompt". "quiz" cues make a quiz available. For task and quiz cues, the track may include a "prompt" (author instructions for you) and a "suggestion"/"copyText" (what the viewer is told to ask you). WHEN the viewer asks a question matching a cue\'s suggestion/copyText (or close to it), find that cue here and follow its "prompt" to generate the response (e.g. invent a fresh quiz, or draft the requested letter in the track persona). Also use this for NAVIGATION: match the viewer\'s request against context titles/topics and branch/clip labels, then pause_video and seek_video to that time.',
    inputSchema: { type: 'object', properties: { ...SESSION_PARAM } }
  },
  // ---- playback control: these push a frame to the browser page ----------
  {
    name: 'resume_video',
    description:
      'Resume playback on the learner\'s player page. Call this when the learner says a step is complete, or asks you to continue the video. If no cue is holding the floor this just presses play.',
    inputSchema: { type: 'object', properties: { ...SESSION_PARAM } }
  },
  {
    name: 'pause_video',
    description: 'Pause playback on the learner\'s player page. Use when the learner asks you to pause, or when you need them to stop and look at something.',
    inputSchema: { type: 'object', properties: { ...SESSION_PARAM } }
  },
  {
    name: 'seek_video',
    description: 'Jump the learner\'s playback to a given time. Use when the learner asks to rewatch a section or skip ahead, for example after choosing a section from get_track. Multi video tracks: pass the video key (from meta.videos in get_track) to jump into a different video of the same track. Playback keeps its current play state, so for a "jump there ready to start" experience call pause_video first, then seek_video, and tell the learner to press play when ready.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Target position in seconds from the start of the video' },
        video: { type: 'string', description: 'Optional. The video key within the track to jump to, from meta.videos in get_track. Omit for the current video.' },
        ...SESSION_PARAM
      },
      required: ['seconds']
    }
  },
  {
    name: 'play_clip',
    description: 'Play a bounded clip: start playback of a video in the track at a start time and, when the end time is reached, automatically return to a given spot (or pause if no return is given). Use this when the learner asks to see a specific moment, for example a funny scene or a referenced callback, without losing their place. Get the video keys and any authored clips or branch choices from get_track. Typical call: play the clip and return them to where they were (read their current video and time from get_state first).',
    inputSchema: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'The video key within the track, from meta.videos. Omit for the main video.' },
        t: { type: 'number', description: 'Clip start in seconds' },
        until: { type: 'number', description: 'Clip end in seconds. When playback reaches it, the player returns or pauses' },
        return_video: { type: 'string', description: 'Optional. Video key to return to when the clip ends' },
        return_t: { type: 'number', description: 'Optional. Time in seconds to return to when the clip ends' },
        ...SESSION_PARAM
      },
      required: ['t', 'until']
    }
  },
  // Navigation by name rather than by number. Preferred over seek_video and
  // play_clip because a viewer says "the bit about editing", not "1,240 seconds",
  // and because bounded destinations return them to where they were afterwards.
  {
    name: 'go_to',
    description:
      'Navigate the learner by NAME to any section or branch destination in the track, at any time, regardless of where playback currently is. Give it what the learner said ("the ludicrous speed bit", "the section about editing") and it matches against section titles, topics, and branch choice labels. Bounded destinations (clips with an end time) play and then return the learner to the position they were at when they asked. Sections simply jump there. If several targets match, it lists them so you can ask the learner which one. Prefer this over seek_video and play_clip whenever the learner names a place rather than a time.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The section or clip the learner asked for, in their words' },
        ...SESSION_PARAM
      },
      required: ['name']
    }
  }
];

/**
 * Wrap a string as MCP tool content.
 *
 * Every tool returns text, including failures. There is no error channel here on
 * purpose: a JSON-RPC error would surface to the viewer as a broken tool, whereas
 * a plain sentence like "No player page is open" is something Claude can read and
 * relay as advice. Read the error strings below as messages to the viewer.
 *
 * @param {string} t
 * @returns {{content:Array<{type:string,text:string}>}}
 */
function text(t) { return { content: [{ type: 'text', text: t }] }; }

/**
 * Find a cue in the loaded track by id.
 * @returns {object|null} Null if no track is loaded or the id is unknown.
 */
function cueById(session, cueId) {
  if (!session.track || !cueId) return null;
  return session.track.cues.find(c => c.id === cueId) || null;
}

/**
 * One-line summary of a session, used when Claude has to ask the viewer which
 * page they mean. Includes the track title and position so the choice can be
 * made from what is on screen rather than from the fingerprint alone.
 */
function describe(s) {
  return {
    fingerprint: s.fingerprint,
    track: s.track ? s.track.meta.title : 'no track loaded',
    playback: Math.floor(s.playback.time) + 's, ' + s.playback.state
  };
}

/**
 * Resolve which player page a tool call is about.
 *
 *   0 pages          tell the viewer to open one
 *   1 page           use it, no questions asked
 *   several, named   match the fingerprint
 *   several, unnamed refuse and ask which
 *
 * The one page case carrying no ceremony is the whole point of the design: the
 * common setup is a single tab, so the viewer should never meet the concept of a
 * session at all. The failure strings are written as instructions to Claude about
 * what to say next, not as diagnostics.
 *
 * @param {object} args Raw tool arguments; only `session` is read.
 * @returns {{session:object}|{error:string}}
 */
function resolveSession(args) {
  const all = listSessions();
  if (all.length === 0) {
    return { error: 'No player page is open. Ask the user to open the Prompt Track player in their browser (http://localhost:' + (process.env.PORT || 3044) + ') and try again.' };
  }
  const term = args && args.session;
  if (term) {
    const found = findByFingerprint(term);
    if (found) return { session: found };
    return { error: 'No open page matches the fingerprint "' + term + '". Open pages right now: ' + JSON.stringify(all.map(describe)) + '. Ask the user which one they mean; each page shows its fingerprint at the top.' };
  }
  if (all.length === 1) return { session: all[0] };
  return { error: 'Several player pages are open, so ask the user which one they mean before answering. Each page shows a two word fingerprint at the top. Open pages: ' + JSON.stringify(all.map(describe)) + '. Then call this tool again with the session argument set to that fingerprint.' };
}

/**
 * The key of a track's primary video.
 *
 * Multi-video tracks list their videos in meta.videos and the first is the main
 * one. Single-video tracks omit the list entirely, so 'main' is the implied key
 * everywhere a cue leaves `video` unset.
 */
function trackMainKey(track) {
  if (track.meta.videos && track.meta.videos.length) return track.meta.videos[0].key || 'video0';
  return 'main';
}
/**
 * The context cue covering the current moment, i.e. which section of the video
 * the viewer is in.
 *
 * Context cues are a silent layer: never shown on screen, they exist so Claude
 * can say something specific about what is on screen right now. This finds the
 * latest one the playhead has passed in the current video.
 *
 * @returns {object|null} The context cue, or null if none applies yet.
 */
function currentContext(session) {
  if (!session.track) return null;
  const t = session.playback.time;
  const vid = session.playback.video || trackMainKey(session.track);
  // Sort by t: cues arrive in timeline order, which is not timestamp order when a
  // track cuts around a source video, so the last array entry is not necessarily the
  // latest section the playhead has passed.
  const sections = session.track.cues
    .filter(c => c.type === 'context' && c.t <= t && ((c.video || trackMainKey(session.track)) === vid))
    .sort((a, b) => a.t - b.t);
  if (!sections.length) return null;
  return sections[sections.length - 1];
}
/**
 * Normalise a references array to {url, title, note, from}.
 *
 * Authors may write a reference as a bare URL string or as an object, so both are
 * accepted and flattened to one shape. Anything without a url is dropped rather
 * than passed through, since a reference Claude cannot open is worse than no
 * reference at all.
 *
 * @param {Array<string|object>} arr Raw references from a track.
 * @param {string} sourceLabel Where it came from ('track', 'section:...', 'cue:...'),
 *   preserved as `from` so Claude can tell a whole-track source from a local one.
 */
function normRefs(arr, sourceLabel) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(r => (typeof r === 'string' ? { url: r } : r))
    .filter(r => r && r.url)
    .map(r => ({ url: r.url, title: r.title || '', note: r.note || '', from: sourceLabel }));
}
/**
 * References that apply to this moment: track-wide, plus the current section's,
 * plus the active cue's.
 *
 * Ordered broadest first so that the most specific source appears last and reads
 * as the most immediately relevant. De-duplicated by url, keeping the first
 * occurrence, so a source cited both track-wide and on a cue is not offered twice.
 *
 * Compare get_references, which returns every source in the whole track.
 */
function relevantReferences(session) {
  if (!session.track) return [];
  const out = [];
  const meta = session.track.meta || {};
  out.push(...normRefs(meta.references, 'track'));
  const section = currentContext(session);
  if (section) out.push(...normRefs(section.references, 'section:' + (section.id || section.title || '')));
  const active = cueById(session, session.activeCueId);
  if (active && active.references) out.push(...normRefs(active.references, 'cue:' + (active.id || '')));
  // De-dupe by url.
  const seen = new Set();
  return out.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

/**
 * Assemble the get_state payload: everything Claude needs to answer the viewer's
 * next message accurately and in character.
 *
 * This is the most important function in the module. It runs before nearly every
 * reply, and what it omits, Claude will invent. The payload deliberately mixes
 * three kinds of thing:
 *
 *   data        playback, activeCue, learner, variables, recentEvents
 *   directives  personaDirective, guidance, referencesGuidance
 *   rules       groundRules, straight from the track
 *
 * Mixing instructions into a data structure is unusual and worth understanding
 * before changing it. There is no system prompt available here: the only channel
 * to the model is tool output, so anything that must shape Claude's behaviour has
 * to travel as a field the model reads. That is why the persona arrives as an
 * imperative sentence rather than a bare string, and why `guidance` differs
 * depending on whether a cue holds the floor.
 *
 * @returns {object} JSON-serialisable state, sent whole.
 */
function stateFor(session) {
  const active = cueById(session, session.activeCueId);
  const persona = session.track && session.track.meta && session.track.meta.persona ? session.track.meta.persona : '';
  const groundRules = session.track && session.track.meta && Array.isArray(session.track.meta.groundRules) ? session.track.meta.groundRules : [];
  const references = relevantReferences(session);
  return {
    fingerprint: session.fingerprint,
    // PERSONA IS A DIRECTIVE, NOT DATA. Adopt it for every reply in this
    // conversation, starting now, including small talk and questions unrelated to a
    // specific cue. Speak, joke and phrase everything as this character. This
    // overrides your default assistant voice for the whole session.
    //
    // (Maintainer's note: the comment above is addressed to the model, not to you.
    // A persona set once at the start of a conversation decays as the exchange
    // goes on, so it is restated on every get_state call, wrapped in an imperative
    // rather than passed as a bare string. Tracks without a persona get an
    // explicit fallback instead of an empty field, so the absence reads as a
    // decision rather than as missing data.)
    personaDirective: persona
      ? ('SPEAK AS THIS CHARACTER IN EVERY REPLY, STARTING NOW: ' + persona)
      : 'This track defines no persona; use a warm, helpful voice.',
    groundRules,
    references,
    referencesGuidance: references.length
      ? 'These are author-vetted sources about the content on screen right now. When the viewer asks something these could answer, READ the relevant url(s) with your web browsing before answering, prefer them over guessing, and cite them. If they do not cover the question, say so rather than inventing.'
      : 'No reference sources are attached for this moment.',
    track: session.track
      ? { title: session.track.meta.title, cueCount: session.track.cues.length }
      : null,
    playback: session.playback,
    currentSection: currentContext(session),
    activeCue: active,
    firedCueIds: session.firedCueIds,
    // Trimmed to id, time and title on purpose. Full cue bodies for cues not yet
    // reached would let Claude answer ahead of the video and spoil the pacing the
    // author built. Anything genuinely needing the whole thing calls get_track.
    remainingCues: session.track
      ? session.track.cues.filter(c => !session.firedCueIds.includes(c.id)).map(c => ({ id: c.id, t: c.t, title: c.title }))
      : [],
    learner: session.learner,
    variables: session.variables,
    // A short tail of the log, enough to see how the viewer arrived here (skipped
    // ahead, rewound twice, needed help on the last cue) without burying the rest
    // of the payload.
    recentEvents: session.log.slice(-15),
    guidance: (persona ? 'Stay fully in persona (see personaDirective) for this and every reply. ' : '')
      + (active
      ? 'A cue is holding the floor and the video is paused there. The page shows the authored card. Answer the viewer\'s questions about it fully here, grounded in the cue content above. When they say the step is done, call resume_video. '
      : 'No cue is holding the floor. Answer from the track and the state above, and use currentSection to speak to where in the video the viewer is. ')
      + 'Code artifacts in cues are the canonical ground truth. Substitute the viewer\'s variable values (above) for {{PLACEHOLDERS}} when presenting code. If asked to adapt, extend or debug code, work from the canonical artifact, preserve the track\'s logic and intent, and state clearly what you changed. Never invent commands, paths or settings that are not in the track or the viewer\'s own pasted content.'
  };
}

/**
 * Run one tool and return its MCP content.
 *
 * Every tool needs a player page, so session resolution happens once up front
 * rather than in each branch. Failures return readable text, never a thrown error;
 * see the note on text().
 *
 * @param {string} mcpKey Identifies the calling MCP connection. Currently unused
 *   for routing, since pages are addressed by fingerprint instead.
 * @param {string} name Tool name from the catalogue.
 * @param {object} args Arguments as supplied by the model.
 * @param {{push?:Function}} hooks From startServer; `push` reaches the browser.
 * @returns {Promise<object>} MCP content.
 */
export async function callTool(mcpKey, name, args, hooks) {
  const push = hooks && hooks.push;
  const known = TOOLS.some(t => t.name === name);
  if (!known) return text('Unknown tool: ' + name);

  const resolved = resolveSession(args);
  if (resolved.error) return text(resolved.error);
  const session = resolved.session;

  switch (name) {
    // Match what the viewer said against the track's task and quiz cues, and if one
    // fits, return its hidden authored prompt for Claude to run.
    //
    // The matcher is intentionally crude: word overlap, no stemming, no embeddings.
    // It only has to separate a handful of cues within one track, and a predictable
    // rule that an author can reason about beats a clever one that surprises them.
    // The cost of a wrong match is real though (the viewer gets a quiz when they
    // wanted a letter), hence the minimum score below.
    case 'activate_prompt': {
      if (!session.track) return text('No track is loaded yet, so there is no authored prompt to run. Answer normally.');
      const query = String((args && args.query) || '').toLowerCase().replace(/\[prompt-track\]/g, '').trim();
      if (!query) return text('No query given. Answer normally.');
      const cues = (session.track.cues || []).filter(c => c.type === 'task' || c.type === 'do' || c.type === 'quiz');
      if (!cues.length) return text('This track has no task or quiz prompts. Answer normally.');
      // Score each candidate by word overlap against its suggestion/copyText/title/intro.
      // Words of three characters or more, so "a", "me", "on" and similar do not
      // score against every cue in the track.
      const qWords = query.split(/\s+/).filter(w => w.length > 2);
      const score = (c) => {
        const hay = ((c.suggestion || '') + ' ' + (c.copyText || '') + ' ' + (c.title || '') + ' ' + (c.intro || '')).toLowerCase();
        if (!hay.trim()) return 0;
        // strong signal: the copyText/suggestion is basically contained
        const target = (c.copyText || c.suggestion || '').toLowerCase().trim();
        if (target && (query.includes(target) || target.includes(query))) return 100;
        let s = 0; for (const w of qWords) if (hay.includes(w)) s++;
        return s;
      };
      let best = null, bestScore = 0;
      for (const c of cues) { const s = score(c); if (s > bestScore) { bestScore = s; best = c; } }
      // Two overlapping words is the floor. One is far too loose: nearly any
      // question shares a single word with some cue, and a spurious match hijacks
      // the reply with the wrong authored prompt. Answering normally is the safer
      // failure, so the threshold favours misses over false hits.
      if (!best || bestScore < 2) {
        return text('No task or quiz prompt matches that closely. If the viewer clearly wants one, ask them which, otherwise answer normally from the track.');
      }
      if (!best.prompt) {
        return text('Matched the "' + (best.title || best.id) + '" ' + best.type + ', but it has no authored prompt. Use its title and intro to help, grounded in the track.');
      }
      logEvent(session, 'prompt_activated', { cueId: best.id, type: best.type });
      const persona = session.track.meta && session.track.meta.persona ? session.track.meta.persona : '';
      // Reassembled with the persona and the interview rule around it, because the
      // authored prompt alone is not enough. Two failure modes are being headed off:
      // dropping character while executing a task, and inventing details (a name, a
      // date, a recipient) instead of asking for them. Both make the output useless
      // to the viewer, and the second is the one models fall into by default.
      const directive =
        'RUN THIS AUTHORED PROMPT NOW. Follow it exactly and stay in the track persona.\n\n' +
        (persona ? ('PERSONA: ' + persona + '\n\n') : '') +
        'AUTHORED PROMPT (' + best.type + ' \u2014 "' + (best.title || best.id) + '"):\n' + best.prompt + '\n\n' +
        'INTERVIEW FIRST: if producing this output needs any specifics you do not have (recipient name, the viewer\'s name, a date, a place, preferences, quiz difficulty, etc.), DO NOT write the final output yet and DO NOT fill blanks with placeholders or invented values. Instead ask the viewer for those details ONE question at a time, wait for each answer, and only once you have what you need, produce the final result. For a quiz, run it interactively one question at a time. Keep everything in persona throughout.';
      return text(directive);
    }

    // Indent of 1 rather than 2: readable enough for a model, slightly cheaper in
    // tokens on a payload sent before nearly every reply.
    case 'get_state':
      return text(JSON.stringify(stateFor(session), null, 1));

    case 'get_references': {
      if (!session.track) return text('No track is loaded yet.');
      const meta = session.track.meta || {};
      const all = [];
      all.push(...normRefs(meta.references, 'track'));
      for (const c of (session.track.cues || [])) {
        if (c.references) all.push(...normRefs(c.references, (c.type || 'cue') + ':' + (c.id || c.title || '')));
      }
      const seen = new Set();
      const deduped = all.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)));
      if (!deduped.length) return text('This track has no reference sources attached.');
      return text(JSON.stringify({
        guidance: 'Read the relevant url(s) with your web browsing before answering questions they could cover; cite them; do not invent facts they do not support.',
        references: deduped
      }, null, 1));
    }

    case 'get_track':
      if (!session.track) return text('No track is loaded on the player page yet. Ask the learner to load one, or to press play so the default track initialises.');
      return text(JSON.stringify(session.track, null, 1));

    case 'resume_video': {
      logEvent(session, 'claude_resumed', {});
      if (push) push(session, { type: 'resume' });
      return text('Resume sent to the player page ("' + session.fingerprint + '"). If a cue was holding the floor it has been released.');
    }

    case 'pause_video': {
      logEvent(session, 'claude_paused', {});
      if (push) push(session, { type: 'pause' });
      return text('Pause sent to the player page ("' + session.fingerprint + '").');
    }

    case 'seek_video': {
      const seconds = Number(args && args.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return text('seek_video needs a non negative number of seconds.');
      logEvent(session, 'claude_seeked', { to: seconds, video: args.video || null });
      if (push) push(session, { type: 'seek', seconds, video: args.video || null });
      return text('Seek to ' + seconds + 's' + (args.video ? ' in video "' + args.video + '"' : '') + ' sent to the player page ("' + session.fingerprint + '").');
    }

    // Navigate by name. Collects every destination the track offers, matches the
    // viewer's words against it, and either goes there or asks which was meant.
    //
    // Two kinds of destination:
    //   section  a context cue. Jump and stay.
    //   clip     a bounded branch choice with an `until`. Play, then return the
    //            viewer to where they were, so a digression does not lose their place.
    case 'go_to': {
      if (!session.track) return text('No track is loaded on the player page yet.');
      const term = String((args && args.name) || '').toLowerCase().trim();
      if (!term) return text('go_to needs a name to look for.');
      const main = trackMainKey(session.track);
      const targets = [];
      for (const c of session.track.cues) {
        const vid = c.video || main;
        if (c.type === 'context') {
          targets.push({ kind: 'section', label: c.title || ('section at ' + c.t + 's'), hay: ((c.title||'') + ' ' + (c.intro||'') + ' ' + ((c.topics||[]).join(' '))).toLowerCase(), video: vid, t: c.t });
        }
        if (c.type === 'branch') {
          const choices = (Array.isArray(c.choices) && c.choices.length) ? c.choices : (c.to ? [c.to] : []);
          for (const ch of choices) {
            targets.push({ kind: ch.until ? 'clip' : 'jump', label: ch.label || (c.title || 'branch') , hay: (((ch.label||'') + ' ' + (c.title||'') + ' ' + (c.intro||''))).toLowerCase(), video: ch.video || vid, t: ch.t, until: ch.until, then: ch.then });
          }
        }
      }
      if (!targets.length) return text('This track has no named sections or branch destinations to navigate to.');
      // Three tiers, strictest first, and the first tier to produce anything wins.
      // Falling straight to any-word would let one common word match half the
      // track; trying the whole phrase and then all-words first means an exact
      // request resolves cleanly and only a vague one widens the net.
      const words = term.split(/\s+/).filter(w => w.length > 2);
      const phrase = targets.filter(tg => tg.hay.includes(term));
      const allWords = words.length ? targets.filter(tg => words.every(w => tg.hay.includes(w))) : [];
      const anyWord = words.length ? targets.filter(tg => words.some(w => tg.hay.includes(w))) : [];
      let matches = phrase.length ? phrase : (allWords.length ? allWords : anyWord);
      // A clip and a section can name the same moment. Collapse matches that
      // point at the same spot, preferring the clip since it returns afterwards.
      // Buckets are five seconds wide (t/5, rounded), because a section marker and
      // a clip start describing the same beat are rarely on the identical frame.
      // Without this the viewer gets asked to choose between two names for one place.
      const bySpot = new Map();
      for (const m of matches) {
        const spot = m.video + ':' + Math.round(m.t / 5);
        const existing = bySpot.get(spot);
        if (!existing || (existing.kind !== 'clip' && m.kind === 'clip')) bySpot.set(spot, m);
      }
      matches = [...bySpot.values()];
      if (!matches.length) {
        return text('Nothing in the track matches "' + (args.name) + '". Available destinations: ' + targets.map(t => t.label + ' (' + t.kind + ')').join('; ') + '. Ask the learner which they meant.');
      }
      if (matches.length > 1) {
        return text('Several destinations match: ' + matches.map(t => t.label + ' (' + t.kind + (t.until ? ', returns afterwards' : '') + ')').join('; ') + '. Ask the learner which one they meant, then call go_to again with more of its name.');
      }
      const tgt = matches[0];
      logEvent(session, 'claude_navigated', { to: tgt.label, kind: tgt.kind });
      if (tgt.kind === 'clip') {
        // Where to send them afterwards: the author's explicit `then` if the track
        // specifies one, otherwise back to the exact spot they asked from.
        const ret = tgt.then
          ? { video: tgt.then.video || (session.playback.video || main), t: Number(tgt.then.t) || 0 }
          : { video: session.playback.video || main, t: Math.max(0, Math.floor(session.playback.time)) };
        if (push) push(session, { type: 'clip', video: tgt.video, seconds: tgt.t, until: tgt.until, ret });
        return text('Playing "' + tgt.label + '" (' + tgt.video + ', ' + tgt.t + 's to ' + tgt.until + 's), then returning the learner to where they were.');
      }
      if (push) push(session, { type: 'seek', seconds: tgt.t, video: tgt.video });
      return text('Jumped to "' + tgt.label + '" (' + tgt.video + ' at ' + tgt.t + 's). Playback keeps its current play state, tell the learner to press play if it was paused.');
    }

    // The manual version of go_to's clip case, for when Claude knows the exact
    // times. Prefer go_to when the viewer named a place rather than a number.
    case 'play_clip': {
      const t = Number(args && args.t);
      const until = Number(args && args.until);
      if (!Number.isFinite(t) || !Number.isFinite(until) || until <= t) return text('play_clip needs t and until in seconds, with until greater than t.');
      const ret = (args.return_video || Number.isFinite(Number(args.return_t)))
        ? { video: args.return_video || null, t: Number(args.return_t) || 0 }
        : null;
      logEvent(session, 'claude_played_clip', { video: args.video || null, t, until });
      if (push) push(session, { type: 'clip', video: args.video || null, seconds: t, until, ret });
      return text('Clip sent to the player page ("' + session.fingerprint + '"): ' + (args.video || 'main video') + ' from ' + t + 's to ' + until + 's' + (ret ? ', returning afterwards' : ', pausing at the end') + '.');
    }
  }
}

// ---- JSON-RPC dispatch -------------------------------------------------

/**
 * Handle one JSON-RPC message and return the reply to write back.
 *
 * The single entry point for all three transports. Returning null means "write
 * nothing", which is required for notifications: replying to one is a protocol
 * violation, and callers translate null into silence (stdio) or a bare 202 (HTTP).
 *
 * Errors are caught and returned as JSON-RPC error objects rather than thrown,
 * so a bad tool call degrades to a message in the conversation instead of killing
 * the connection and forcing the viewer to restart Claude Desktop.
 *
 * @param {string} mcpKey Identifies the calling connection.
 * @param {object} msg Parsed JSON-RPC message.
 * @param {{push?:Function}} hooks From startServer.
 * @returns {Promise<object|null>} Reply, or null for notifications.
 */
export async function handleRpc(mcpKey, msg, hooks) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  // JSON-RPC: a message without an id is a notification and must go unanswered.
  const isNotification = (id === undefined || id === null);

  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      // Handshake. `instructions` is the one chance to brief Claude before any
      // tool is called, so it front-loads the two rules most likely to be skipped:
      // call get_state before replying, and call activate_prompt before answering
      // anything that smells like an authored task. Everything else can be
      // discovered from the tools themselves.
      case 'initialize':
        return reply({
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Prompt Track companion server. The viewer watches a video on a player page that pauses at authored cues, and asks you their questions here. ' +
            'PERSONA: many tracks define a character for you to play. Call get_state before your first reply and whenever the viewer speaks; it returns a personaDirective. You MUST speak entirely as that character in EVERY reply for the whole session, including greetings, small talk and questions unrelated to any cue. This overrides your default assistant voice. ' +
            'Ground every answer in get_state (the current moment) and get_track (the whole track). Never invent commands, paths or settings. ' +
            'REFERENCES: the track may attach author-vetted source URLs (globally and per cue), surfaced in get_state.references and via get_references. When the viewer asks about the content and a source could answer it, READ the relevant url with your own web browsing and answer from it with a citation, rather than guessing. Prefer these vetted sources; if they do not cover the question, say so. ' +
            'CRITICAL: whenever the viewer\'s message contains the marker [prompt-track], OR reads like a track task or quiz (for example "quiz me on...", "write a letter...", "help me with this task"), you MUST call activate_prompt FIRST and follow the authored prompt it returns, before writing any answer. Do not fulfil such requests from the plain wording alone; the real instructions live in the cue\'s hidden prompt. If activate_prompt returns a prompt that needs details you lack, interview the viewer one question at a time and wait for answers before producing the final output. ' +
            'If more than one player page is open, ask which fingerprint they mean, it is shown at the top of each page.'
        });

      // Both spellings accepted: clients differ on which they send, and the
      // handshake is finished either way.
      case 'notifications/initialized':
      case 'initialized':
        return null;

      // Liveness check. Can arrive as a request or a notification.
      case 'ping':
        return isNotification ? null : reply({});

      case 'tools/list':
        return reply({ tools: TOOLS });

      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const result = await callTool(mcpKey, name, args, hooks);
        return reply(result);
      }

      default:
        if (isNotification) return null;
        return fail(-32601, 'Method not found: ' + method);
    }
  } catch (err) {
    if (isNotification) return null;
    return fail(-32603, 'Internal error: ' + (err && err.message));
  }
}
