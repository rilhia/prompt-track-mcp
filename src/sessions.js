// sessions.js
// Every open player page is a session, identified for humans by a two word
// fingerprint shown on the page (for example "fox amber"). No pairing: the
// server and Claude Desktop live on the same machine as the same user, so
// tools target the only open page, or ask which fingerprint when several are.
//
// WHY FINGERPRINTS RATHER THAN A PAIR CODE
// An earlier design made the viewer read a code from the page into the chat to
// link the two. That turned out to be a step nobody needed: both ends are the
// same person on the same machine, so there is nothing to authenticate. The
// fingerprint survives only as a disambiguator for the uncommon case of several
// player tabs open at once, where a tool call has to be told which one it means.
//
// LIFETIME AND STORAGE
// Sessions live in a plain in-memory Map for the life of the process. They are
// created when a browser opens the WebSocket and destroyed when it closes, so a
// page refresh yields a brand new session with a new fingerprint and an empty
// log. Nothing is written to disk and nothing survives a server restart. That is
// deliberate: a session is a live conversation about a video, not a record worth
// keeping, and it keeps the extension free of any persistence or privacy surface.
//
// SHAPE OF A SESSION
//   id           uuid, internal, never shown to the viewer
//   ws           the live WebSocket to that browser page
//   fingerprint  the two word human handle shown on the page
//   track        the track JSON the page has loaded, or null
//   playback     {time, state, video} as last reported by the page
//   activeCueId  the cue currently holding the floor, or null
//   firedCueIds  cues already triggered, so they do not fire twice
//   learner      {os, comfort} from the calibration questions
//   variables    viewer supplied values substituted into code artifacts
//   log          a capped ring of events, newest last

import crypto from 'crypto';

/** Live sessions, keyed by session id. In memory only, cleared on restart. */
const SESSIONS = new Map(); // sessionId -> session

/**
 * Maximum events retained per session. The log is only ever read as "the last
 * fifteen or so things that happened" by get_state, so old entries are dead
 * weight. Capping it stops a long viewing session growing unbounded.
 */
const LOG_CAP = 200;

// Two small word lists giving 100 combinations. Chosen to be short, unambiguous
// when spoken aloud, and visually distinct from each other in a browser tab.
const ANIMALS = ['fox','owl','badger','otter','heron','stoat','wren','hare','mole','swift'];
const COLOURS = ['amber','cyan','violet','jade','coral','slate','gold','rose','teal','lime'];

/**
 * Pick a two word fingerprint not already in use by another open page.
 *
 * With only 100 combinations, collisions are likely once a handful of pages are
 * open, so this retries rather than trusting randomness. The 200 attempt ceiling
 * is a safety valve, not a real limit: it can only be reached with an absurd
 * number of simultaneous pages, and the numeric fallback keeps the session
 * usable rather than throwing.
 *
 * @returns {string} An unused fingerprint, e.g. "fox amber".
 */
function freshFingerprint() {
  for (let i = 0; i < 200; i++) {
    const fp = ANIMALS[crypto.randomInt(ANIMALS.length)] + ' ' + COLOURS[crypto.randomInt(COLOURS.length)];
    let taken = false;
    for (const s of SESSIONS.values()) if (s.fingerprint === fp) { taken = true; break; }
    if (!taken) return fp;
  }
  return 'page ' + crypto.randomInt(1000, 9999);
}

/**
 * Register a newly connected player page and return its session.
 *
 * @param {import('ws').WebSocket} ws Live socket to the browser page.
 * @returns {object} The new session, already stored and logged.
 */
export function createSession(ws) {
  const s = {
    id: crypto.randomUUID(),
    ws,
    createdAt: Date.now(),
    fingerprint: freshFingerprint(),
    track: null,
    playback: { time: 0, state: 'unstarted' },
    activeCueId: null,
    firedCueIds: [],
    learner: { os: null, comfort: null },
    variables: {},
    log: []
  };
  SESSIONS.set(s.id, s);
  logEvent(s, 'session_started', {});
  return s;
}

/**
 * Forget a session. Called when its WebSocket closes. Silently does nothing if
 * the id is unknown, so a double close is harmless.
 *
 * @param {string} sessionId
 */
export function endSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) return;
  logEvent(s, 'session_ended', {});
  SESSIONS.delete(sessionId);
}

/**
 * Look up a session by id.
 *
 * Worth calling rather than holding a reference: a session captured in a closure
 * may since have been ended by its socket closing, and this returns null in that
 * case instead of handing back a stale object.
 *
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getSession(sessionId) { return SESSIONS.get(sessionId) || null; }

/**
 * Every open session, as an array.
 * @returns {object[]}
 */
export function listSessions() { return [...SESSIONS.values()]; }

/**
 * Find a session from something the viewer typed.
 *
 * Deliberately forgiving, because this value reaches us via the viewer saying a
 * fingerprint to Claude and Claude passing it on. Tries an exact match first,
 * then falls back to a substring match so that "fox" finds "fox amber". Exact
 * wins to avoid a partial term shadowing a real name.
 *
 * @param {string} term Whole or partial fingerprint, any case.
 * @returns {object|null} The matching session, or null.
 */
export function findByFingerprint(term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return null;
  const all = listSessions();
  return all.find(s => s.fingerprint.toLowerCase() === t)
      || all.find(s => s.fingerprint.toLowerCase().includes(t))
      || null;
}

/**
 * Append an event to a session's log, trimming the oldest once past LOG_CAP.
 *
 * The log is what lets Claude say something useful about how the viewer got
 * here, so events should read as a narrative of what happened rather than as
 * debug output.
 *
 * @param {object} session
 * @param {string} type Short event name, e.g. 'cue_fired'.
 * @param {object} data Extra fields, spread onto the entry.
 */
export function logEvent(session, type, data) {
  session.log.push({ at: new Date().toISOString(), type, ...data });
  if (session.log.length > LOG_CAP) session.log.splice(0, session.log.length - LOG_CAP);
}

/**
 * How many player pages are currently connected. Used by /health.
 * @returns {number}
 */
export function sessionCount() { return SESSIONS.size; }
