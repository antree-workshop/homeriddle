'use strict';

// Homeriddle: a zero-dependency party mystery server.
// Run with `node server.js` and open the URL it prints.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { analyzeCase } = require('./logic');

// Other projects on the home server restart their own "node server.js" with
// `pkill -f server.js`; a process title of our own keeps the game out of that.
process.title = 'homeriddle';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MYSTERY_FILE = path.resolve(process.env.MYSTERY || path.join(__dirname, 'mystery.json'));

const DEFAULT_SETTINGS = {
  updateIntervalMinutes: 7,
  lastCallMinutes: 5,
  wrongCooldownSeconds: 120,
  maxWrongAccusationsPerCase: 3,
  lateJoinerCards: 2,
  scoring: {
    correctBase: 100,
    perUpdatePenalty: 10,
    minCorrect: 30,
    firstSolverBonus: 50,
    lastCallMultiplier: 0.5,
    wrongPenalty: 10,
  },
};

// ---------------------------------------------------------------------------
// Mystery loading & validation

function loadMystery(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const settings = {
    ...DEFAULT_SETTINGS,
    ...raw.settings,
    scoring: { ...DEFAULT_SETTINGS.scoring, ...(raw.settings && raw.settings.scoring) },
  };
  const errors = [];
  const warnings = [];
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) errors.push('mystery needs at least one case');

  (raw.cases || []).forEach((c, ci) => {
    const where = `Case ${ci + 1} "${c.title || 'untitled'}"`;
    const keys = new Set();
    for (const cat of c.categories || []) {
      if (keys.has(cat.key)) errors.push(`${where}: duplicate category key "${cat.key}"`);
      keys.add(cat.key);
      const ids = new Set();
      for (const o of cat.options || []) {
        if (ids.has(o.id)) errors.push(`${where}: duplicate option "${o.id}" in ${cat.key}`);
        ids.add(o.id);
      }
      const sol = c.solution && c.solution[cat.key];
      if (!ids.has(sol)) errors.push(`${where}: solution for "${cat.key}" is "${sol}", which is not an option`);
    }
    if (!keys.size) errors.push(`${where}: needs categories`);
    if (!Array.isArray(c.clues) || !c.clues.length) errors.push(`${where}: needs clues`);
    if (errors.length) return;

    // Golden clues come from the vault, not from an update, so they don't add one.
    c.updates = Math.max(0, ...c.clues.filter((x) => !x.vault).map((x) => x.release || 0));
    const analysis = analyzeCase(c, where);
    errors.push(...analysis.errors);
    warnings.push(...analysis.warnings);
    c.analysis = analysis.stages || [];
  });

  // The TV lobby's lineup: suspects picked from any case ({ "case": 2, "id": "housekeeper" }).
  for (const pick of raw.lobbyCast || []) {
    const c = raw.cases[pick.case - 1];
    const cat = c && c.categories && c.categories[0];
    if (!cat || !(cat.options || []).some((o) => o.id === pick.id)) {
      errors.push(`lobbyCast: case ${pick.case} has no suspect "${pick.id}"`);
    }
  }

  if (errors.length) {
    throw new Error(`Problems in ${file}:\n  - ${errors.join('\n  - ')}\n(Run "node verify.js --verbose" for details.)`);
  }
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  return { ...raw, settings };
}

const mystery = loadMystery(MYSTERY_FILE);

// ---------------------------------------------------------------------------
// State

function freshState(hostKey) {
  return {
    hostKey: hostKey || process.env.HOST_KEY || crypto.randomBytes(4).toString('hex'),
    phase: 'lobby', // lobby | active | lastcall | revealed | finished
    caseIndex: 0,
    round: null,
    intervalMs: mystery.settings.updateIntervalMinutes * 60_000,
    players: {},
    feed: [],
    completed: [], // case indices whose solution has been revealed
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.caseIndex >= mystery.cases.length || (s.round && !s.round.updates)) {
      throw new Error('saved game does not match this version or mystery');
    }
    // A night can only end after a case has run; heal saves from before that was enforced.
    if (s.phase === 'finished' && !s.round) s.phase = 'lobby';
    remapHands(s);
    return s;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not load saved state (${err.message}); starting fresh.`);
    return freshState();
  }
}

// Hands hold clue positions, and the save remembers each case's clue texts. If
// mystery.json changed since (a clue added, removed or moved by a deploy during the
// party), find every held clue again by its text, so nobody ends up holding the wrong
// clue or one that no longer exists. A reworded clue keeps its place if the case still
// has the same number of clues; otherwise it is dropped.
function remapHands(s) {
  const saved = s.clueTexts || [];
  let lost = 0;
  for (const p of Object.values(s.players || {})) {
    for (const [ci, hand] of Object.entries(p.cards || {})) {
      const c = mystery.cases[ci];
      const old = saved[ci];
      const kept = new Set();
      for (const i of c ? hand : []) {
        const j = c.clues.findIndex((x) => x.text === (old ? old[i] : c.clues[i]?.text));
        if (j >= 0) kept.add(j);
        else if (old && old.length === c.clues.length && c.clues[i]) kept.add(i);
        else lost++;
      }
      if (!c) lost += hand.length;
      p.cards[ci] = [...kept];
    }
  }
  if (lost) console.warn(`⚠️  ${lost} dealt clue(s) no longer exist in ${MYSTERY_FILE} and were taken back from players.`);
}

let state = loadState();
if (process.env.HOST_KEY) state.hostKey = process.env.HOST_KEY;

function writeState() {
  state.clueTexts = mystery.cases.map((c) => c.clues.map((x) => x.text));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeState, 200);
}

// A deploy or Ctrl-C stops the server: write any change still waiting for the timer.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearTimeout(saveTimer);
    writeState();
    process.exit(0);
  });
}

// Clients poll /api/state, so a change only needs saving.
const changed = save;

const currentCase = () => mystery.cases[state.caseIndex];
const playerList = () => Object.values(state.players);
const releasedCount = () => (state.round ? state.round.updates.length : 0);

function feed(type, text) {
  state.feed.push({ type, text, at: Date.now() });
  if (state.feed.length > 200) state.feed.splice(0, state.feed.length - 200);
}

// Accusations made during the current run of the current case. Tagging them with the
// round (not just the case) lets the host replay a case without old guesses counting.
function thisRound(p) {
  const id = state.round && state.round.startedAt;
  return id ? p.accusations.filter((a) => a.round === id) : [];
}

// A wrong accusation uses up one of the case's tries, unless the host gave it back.
// The points it cost stay either way.
const usesATry = (a) => !a.correct && !a.forgiven;

function playerScore(p) {
  const fromAccusations = p.accusations.reduce((sum, a) => sum + a.points, 0);
  const fromBonuses = p.bonuses.reduce((sum, b) => sum + b.amount, 0);
  return fromAccusations + fromBonuses;
}

// Vault points stay off the public leaderboard until the case is revealed: a score that
// jumps without a solve would tell everyone who opened the vault. Only the opener's own
// phone and the host see them before that.
function hiddenVaultPoints(p) {
  const id = state.round && state.round.startedAt;
  if (!id || (state.phase !== 'active' && state.phase !== 'lastcall')) return 0;
  return p.bonuses.filter((b) => b.vault && b.round === id).reduce((sum, b) => sum + b.amount, 0);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const secretClues = (c, release) =>
  c.clues.map((x, i) => ({ ...x, i })).filter((x) => !x.public && !x.vault && (x.release || 0) === release).map((x) => x.i);

// Hand out the secret clues of one release. At the start everyone gets at least
// one clue (copies if needed). Later releases go to one player each, preferring
// whoever holds the fewest clues, which makes those players worth tracking down.
function dealSecrets(release) {
  const ci = state.caseIndex;
  const clues = shuffle(secretClues(currentCase(), release));
  const players = shuffle(playerList()).sort((a, b) => (a.cards[ci] || []).length - (b.cards[ci] || []).length);
  const receivers = [];
  if (!players.length || !clues.length) return receivers;
  const total = release === 0 ? Math.max(clues.length, players.length) : clues.length;
  for (let k = 0; k < total; k++) {
    const p = players[k % players.length];
    const hand = (p.cards[ci] = p.cards[ci] || []);
    const clue = clues[k % clues.length];
    if (!hand.includes(clue)) hand.push(clue);
    if (!receivers.includes(p.id)) receivers.push(p.id);
  }
  return receivers;
}

function dealLateJoiner(p) {
  const c = currentCase();
  const released = [];
  for (let r = 0; r <= releasedCount(); r++) released.push(...secretClues(c, r));
  p.cards[state.caseIndex] = shuffle(released).slice(0, mystery.settings.lateJoinerCards);
}

// ---------------------------------------------------------------------------
// Game flow

function startCase(index) {
  if (index < 0 || index >= mystery.cases.length) throw new Error('No such case');
  const now = Date.now();
  state.caseIndex = index;
  state.phase = 'active';
  state.round = {
    startedAt: now,
    updates: [],
    nextUpdateAt: mystery.cases[index].updates ? now + state.intervalMs : null,
    paused: false,
    pausedRemaining: null,
    lastCallEndsAt: null,
    solvers: [],
  };
  roundVault();
  for (const p of playerList()) {
    p.cards[index] = [];
    p.cooldownUntil = 0; // a new case starts with everyone free to guess
  }
  dealSecrets(0);
  feed('case', `Case ${index + 1} begins: ${mystery.cases[index].title}`);
}

function releaseUpdate() {
  const r = state.round;
  const c = currentCase();
  if (state.phase !== 'active' || r.updates.length >= c.updates) return false;
  const number = r.updates.length + 1;
  const receivers = dealSecrets(number);
  r.updates.push({ number, at: Date.now(), receivers });
  const pub = c.clues.filter((x) => x.public && x.release === number);
  for (const x of pub) feed('update', `Update ${number}: ${x.text}`);
  if (receivers.length) {
    const names = receivers.map((id) => state.players[id].name).join(', ');
    feed('update', `Update ${number}: new secret evidence for ${names}`);
  }
  const more = r.updates.length < c.updates;
  r.nextUpdateAt = more ? Date.now() + state.intervalMs : null;
  if (r.paused) r.pausedRemaining = more ? state.intervalMs : null;
  return true;
}

// ---------------------------------------------------------------------------
// The vault: a side puzzle in every case. It has a secret 4-digit code (all digits
// different), and each guess gets private Mastermind feedback: digits right and in the
// right place, and digits right but in the wrong place. Every player who opens it gets
// points; the first also gets the case's golden clue (clues marked "vault": true). Later
// openers are never told the vault was already emptied. The TV only learns
// that someone is trying, never who.
//
// Every opener gets the same points, so nobody can tell from their score that the
// vault was already emptied.
//
// Two styles alternate between cases (a case can pick one with "vaultStyle"):
//   mastermind: only the counts, sorted, so you don't learn which digit was right;
//   wordle:     a mark under every digit, which is easier and faster.

const vaultSettings = () => ({ points: 40, cooldownSeconds: 60, ...(mystery.settings.vault || {}) });

function roundVault() {
  const r = state.round;
  if (!r) return null;
  if (!r.vault) r.vault = { code: shuffle([...'0123456789']).slice(0, 4).join(''), openers: [], attempts: 0, lastAttemptAt: 0 };
  if (!r.vault.style) r.vault.style = currentCase().vaultStyle || (state.caseIndex % 2 === 0 ? 'mastermind' : 'wordle');
  return r.vault;
}

// exact/near counts, plus a mark per digit (g right place, y wrong place, x not in the
// code). The marks are only shown in wordle style.
function vaultFeedback(code, guess) {
  let exact = 0;
  let near = 0;
  let marks = '';
  for (let i = 0; i < code.length; i++) {
    if (guess[i] === code[i]) { exact++; marks += 'g'; }
    else if (code.includes(guess[i])) { near++; marks += 'y'; }
    else marks += 'x';
  }
  return { exact, near, marks };
}

// This player's guesses at the vault of the current run of the current case.
function vaultGuesses(p) {
  const id = state.round && state.round.startedAt;
  return id ? (p.vaultGuesses || []).filter((g) => g.round === id) : [];
}

function tryVault(p, guess) {
  if (state.vaultOff) throw new Error('The vault is sealed tonight');
  if (state.phase !== 'active' && state.phase !== 'lastcall') throw new Error('The vault only opens while a case is on');
  guess = String(guess || '');
  if (!/^\d{4}$/.test(guess) || new Set(guess).size !== 4) throw new Error('Enter 4 different digits');
  const v = roundVault();
  const vs = vaultSettings();
  const now = Date.now();
  const mine = vaultGuesses(p);
  if (mine.some((g) => g.exact === 4)) throw new Error('You already opened this vault');
  const last = mine[mine.length - 1];
  const wait = last ? last.at + vs.cooldownSeconds * 1000 - now : 0;
  if (wait > 0) throw new Error(`The tumblers are still settling. Try again in ${Math.ceil(wait / 1000)} s`);

  const entry = { round: state.round.startedAt, guess, ...vaultFeedback(v.code, guess), at: now };
  p.vaultGuesses = [...(p.vaultGuesses || []), entry];
  v.attempts++;
  v.lastAttemptAt = now;
  if (entry.exact === 4) {
    const first = v.openers.length === 0;
    entry.points = vs.points;
    v.openers.push({ playerId: p.id, at: now, points: entry.points });
    p.bonuses.push({ amount: entry.points, reason: 'Cracked the vault', at: now, vault: true, round: state.round.startedAt });
    if (first) {
      const c = currentCase();
      const golden = c.clues.map((x, i) => (x.vault ? i : -1)).filter((i) => i >= 0);
      const hand = (p.cards[state.caseIndex] = p.cards[state.caseIndex] || []);
      for (const i of golden) if (!hand.includes(i)) hand.push(i);
      entry.found = golden.length > 0;
    }
  }
  return entry;
}

function revealSolution() {
  if (state.phase !== 'active' && state.phase !== 'lastcall') return;
  state.phase = 'revealed';
  state.round.revealedAt = Date.now();
  state.completed = [...new Set([...(state.completed || []), state.caseIndex])];
  state.round.nextUpdateAt = null;
  feed('reveal', `The truth is revealed: ${solutionSentence(currentCase())}`);
}

function solutionSentence(c) {
  return c.categories
    .map((cat) => cat.options.find((o) => o.id === c.solution[cat.key]).name)
    .join(' · ');
}

function accuse(p, answer) {
  const c = currentCase();
  const r = state.round;
  const s = mystery.settings;
  const now = Date.now();
  if (state.phase !== 'active' && state.phase !== 'lastcall') throw new Error('No case is open right now');
  if (r.solvers.some((x) => x.playerId === p.id)) throw new Error('You already solved this case');
  if (p.cooldownUntil > now) throw new Error('Your accusation is still on cooldown');
  const wrongSoFar = thisRound(p).filter(usesATry).length;
  if (s.maxWrongAccusationsPerCase && wrongSoFar >= s.maxWrongAccusationsPerCase) {
    throw new Error('You are out of accusations for this case');
  }
  for (const cat of c.categories) {
    if (!cat.options.some((o) => o.id === (answer && answer[cat.key]))) {
      throw new Error(`Pick an answer for "${cat.label}"`);
    }
  }

  const correct = c.categories.every((cat) => answer[cat.key] === c.solution[cat.key]);
  let points;
  if (correct) {
    const sc = s.scoring;
    points = Math.max(sc.minCorrect, sc.correctBase - sc.perUpdatePenalty * r.updates.length);
    if (state.phase === 'lastcall') points = Math.round(points * sc.lastCallMultiplier);
    if (r.solvers.length === 0) points += sc.firstSolverBonus;
    r.solvers.push({ playerId: p.id, at: now, points });
    if (r.solvers.length === 1) {
      feed('solve', `${p.name} has SOLVED the case! (+${points})`);
      r.nextUpdateAt = null;
      if (s.lastCallMinutes > 0) {
        state.phase = 'lastcall';
        r.lastCallEndsAt = now + s.lastCallMinutes * 60_000;
      } else {
        revealSolution();
      }
    } else {
      feed('solve', `${p.name} also cracked it! (+${points})`);
    }
    if (r.solvers.length >= playerList().length) revealSolution();
  } else {
    points = -s.scoring.wrongPenalty;
    p.cooldownUntil = now + s.wrongCooldownSeconds * 1000;
    feed('wrong', `${p.name} made an accusation... and was WRONG.`);
  }
  // Keep only the answer itself, not whatever else the request carried.
  const picked = Object.fromEntries(c.categories.map((cat) => [cat.key, answer[cat.key]]));
  p.accusations.push({ caseIndex: state.caseIndex, round: r.startedAt, answer: picked, correct, points, at: now });
  return { correct, points };
}

function tick() {
  const r = state.round;
  const now = Date.now();
  if (state.phase === 'active' && r && !r.paused && r.nextUpdateAt && now >= r.nextUpdateAt) {
    if (releaseUpdate()) changed();
  } else if (state.phase === 'lastcall' && r.lastCallEndsAt && now >= r.lastCallEndsAt) {
    revealSolution();
    changed();
  }
}
setInterval(tick, 1000);

// ---------------------------------------------------------------------------
// Views (what each audience may see)

function leaderboard() {
  return playerList()
    .map((p) => ({
      id: p.id,
      name: p.name,
      costume: p.costume,
      score: playerScore(p) - hiddenVaultPoints(p),
      solved: p.accusations.filter((a) => a.correct).length,
      joinedAt: p.joinedAt,
    }))
    .sort((a, b) => b.score - a.score || b.solved - a.solved || a.joinedAt - b.joinedAt);
}

// Visual traits are left out entirely, not just hidden by the page: players must find
// them in the portraits, not in the data their phone downloads.
function publicCategory({ key, label, traits = [], options }) {
  const hidden = new Set(traits.filter((t) => t.visual).map((t) => t.key));
  return {
    key,
    label,
    traits: traits.filter((t) => !t.visual),
    options: options.map((o) => ({
      ...o,
      traits: Object.fromEntries(Object.entries(o.traits || {}).filter(([k]) => !hidden.has(k))),
    })),
  };
}

function publicCase() {
  if (state.phase === 'lobby' || !state.round) return null;
  const c = currentCase();
  const r = state.round;
  const revealed = state.phase === 'revealed' || state.phase === 'finished';
  const publicAt = (n) => c.clues.filter((x) => x.public && (x.release || 0) === n).map((x) => x.text);
  return {
    title: c.title,
    intro: c.intro,
    question: c.question,
    categories: c.categories.map(publicCategory),
    facts: publicAt(0),
    updates: r.updates.map((u) => ({
      number: u.number,
      at: u.at,
      clues: publicAt(u.number),
      receivers: u.receivers.map((id) => state.players[id]?.name).filter(Boolean),
    })),
    totalUpdates: c.updates,
    nextUpdateAt: r.nextUpdateAt,
    paused: r.paused,
    pausedRemaining: r.pausedRemaining,
    lastCallEndsAt: r.lastCallEndsAt,
    solvers: r.solvers.map((x) => ({ name: state.players[x.playerId]?.name || '?', at: x.at, points: x.points })),
    solution: revealed
      ? { summary: solutionSentence(c), answer: c.solution, story: c.solutionStory || '' }
      : null,
  };
}

// Addresses guests can open. Home-network addresses come first because the TV's QR code
// uses the first one; VPN addresses (e.g. Tailscale's 100.64.0.0/10) are unreachable for
// guests' phones. PUBLIC_URL overrides everything.
function lanUrls() {
  if (process.env.PUBLIC_URL) return [process.env.PUBLIC_URL.replace(/\/?$/, '/')];
  const isHome = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  ips.sort((a, b) => isHome(b) - isHome(a));
  return ips.map((ip) => `http://${ip}:${PORT}/`);
}

// Suspects shown on the TV before the game starts: mystery.lobbyCast if set (any mix of
// cases), otherwise the current case's suspects.
function lobbyCast() {
  if (!mystery.lobbyCast || !mystery.lobbyCast.length) return currentCase().categories[0].options;
  return mystery.lobbyCast.map((pick) => mystery.cases[pick.case - 1].categories[0].options.find((o) => o.id === pick.id));
}

function publicState() {
  return {
    serverNow: Date.now(),
    title: mystery.title,
    tagline: mystery.tagline,
    prologue: mystery.prologue,
    phase: state.phase,
    caseIndex: state.caseIndex,
    caseCount: mystery.cases.length,
    case: publicCase(),
    cast: lobbyCast().map(({ id, name, desc, image, icon }) => ({ id, name, desc, image, icon })),
    leaderboard: leaderboard(),
    feed: state.feed.slice(-40),
    joinUrls: lanUrls(),
    wifi: state.wifi || null,
    vault: { on: !state.vaultOff, lastAttemptAt: (state.round && state.round.vault && state.round.vault.lastAttemptAt) || 0 },
    rules: {
      updateIntervalMinutes: state.intervalMs / 60_000,
      lastCallMinutes: mystery.settings.lastCallMinutes,
      wrongCooldownSeconds: mystery.settings.wrongCooldownSeconds,
      maxWrongAccusationsPerCase: mystery.settings.maxWrongAccusationsPerCase,
      scoring: mystery.settings.scoring,
    },
  };
}

function playerView(p) {
  const c = currentCase();
  const accusations = thisRound(p);
  const wrong = accusations.filter(usesATry).length;
  const max = mystery.settings.maxWrongAccusationsPerCase;
  const board = leaderboard();
  return {
    id: p.id,
    name: p.name,
    costume: p.costume,
    score: playerScore(p),
    vaultPending: hiddenVaultPoints(p), // in `score`, but not on the leaderboard yet
    rank: board.findIndex((x) => x.id === p.id) + 1,
    cards: state.phase === 'lobby'
      ? []
      : (p.cards[state.caseIndex] || []).map((i) => ({ text: c.clues[i].text, release: c.clues[i].release || 0, vault: !!c.clues[i].vault })),
    accusations,
    solved: accusations.some((a) => a.correct),
    cooldownUntil: p.cooldownUntil,
    accusationsLeft: max ? Math.max(0, max - wrong) : null,
    vault: (() => {
      const guesses = vaultGuesses(p);
      const last = guesses[guesses.length - 1];
      return {
        style: state.round ? roundVault().style : 'mastermind',
        // Per-digit marks only in wordle style, so a mastermind round doesn't leak them.
        guesses: guesses.map(({ guess, exact, near, marks, at, points }) =>
          ({ guess, exact, near, at, points, ...(roundVault().style === 'wordle' ? { marks } : {}) })),
        opened: guesses.some((g) => g.exact === 4),
        nextTryAt: last ? last.at + vaultSettings().cooldownSeconds * 1000 : 0,
        cooldownSeconds: vaultSettings().cooldownSeconds,
      };
    })(),
  };
}

function hostView() {
  const c = currentCase();
  const next = releasedCount() + 1;
  return {
    hostKey: state.hostKey,
    intervalMs: state.intervalMs,
    cases: mystery.cases.map((x, i) => ({
      title: x.title,
      solution: solutionSentence(x),
      updates: x.updates,
      done: (state.completed || []).includes(i),
    })),
    analysis: c.analysis,
    released: releasedCount(),
    players: playerList().map((p) => ({
      id: p.id,
      name: p.name,
      costume: p.costume,
      token: p.token,
      sameDevice: p.device ? playerList().filter((q) => q !== p && q.device === p.device).map((q) => q.name) : [],
      score: playerScore(p),
      joinedAt: p.joinedAt,
      cards: (p.cards[state.caseIndex] || []).map((i) => c.clues[i].text),
      accusations: thisRound(p),
      bonuses: p.bonuses,
    })),
    vault: state.round
      ? {
          off: !!state.vaultOff,
          code: roundVault().code,
          style: roundVault().style,
          attempts: roundVault().attempts,
          openers: roundVault().openers.map((o) => ({ name: state.players[o.playerId]?.name || '?', at: o.at, points: o.points })),
          golden: c.clues.filter((x) => x.vault).map((x) => x.text),
        }
      : { off: !!state.vaultOff },
    upcoming: state.round && next <= c.updates
      ? c.clues.filter((x) => x.release === next).map((x) => ({ text: x.text, public: !!x.public }))
      : [],
  };
}

// ---------------------------------------------------------------------------
// HTTP

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    // A phone that drops mid-request must not leave the request hanging forever.
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('Request aborted')); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function findPlayer(req) {
  const token = req.headers['x-player-token'];
  return token ? playerList().find((p) => p.token === token) : null;
}

// Guests' phones each have their own address on the home Wi-Fi. The machine running the
// server (loopback) is left out, so a local test run can use several tabs.
function deviceOf(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return !ip || ip === '::1' || ip.startsWith('127.') ? null : ip;
}

function isHost(req) {
  return req.headers['x-host-key'] === state.hostKey;
}

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function hostAction(body) {
  const r = state.round;
  switch (body.action) {
    case 'start':
      startCase(Number.isInteger(body.caseIndex) ? body.caseIndex : state.caseIndex);
      break;
    case 'next':
      if (state.caseIndex + 1 >= mystery.cases.length) {
        if (!r) throw new Error('Play a case before ending the night');
        state.phase = 'finished';
        feed('case', 'The night is over. Final scores are in!');
      } else {
        startCase(state.caseIndex + 1);
      }
      break;
    case 'pause':
      if (state.phase === 'active' && !r.paused) {
        r.paused = true;
        r.pausedRemaining = r.nextUpdateAt ? Math.max(0, r.nextUpdateAt - Date.now()) : null;
      }
      break;
    case 'resume':
      if (r && r.paused) {
        r.paused = false;
        r.nextUpdateAt = r.pausedRemaining != null ? Date.now() + r.pausedRemaining : null;
        r.pausedRemaining = null;
      }
      break;
    case 'update':
      if (!releaseUpdate()) throw new Error('No more updates for this case (or the case is not active)');
      break;
    case 'reveal':
      revealSolution();
      break;
    case 'finish':
      if (!r) throw new Error('Play a case before ending the night');
      state.phase = 'finished';
      feed('case', 'The night is over. Final scores are in!');
      break;
    case 'interval': {
      const minutes = Number(body.minutes);
      if (!(minutes >= 0.25 && minutes <= 120)) throw new Error('Interval must be 0.25 to 120 minutes');
      state.intervalMs = Math.round(minutes * 60_000);
      if (r && state.phase === 'active' && r.nextUpdateAt) {
        if (r.paused) r.pausedRemaining = state.intervalMs;
        else r.nextUpdateAt = Date.now() + state.intervalMs;
      }
      break;
    }
    case 'vault':
      state.vaultOff = !body.on;
      break;
    case 'wifi': {
      // Shown on the TV as a "join the Wi-Fi" QR code next to the game's own.
      // Not clean(): spaces inside a network name or password matter.
      const ssid = String(body.ssid || '').trim().slice(0, 32);
      state.wifi = ssid ? { ssid, password: String(body.password || '').slice(0, 63) } : null;
      break;
    }
    case 'bonus': {
      const p = state.players[body.playerId];
      const amount = Math.round(Number(body.amount));
      if (!p || !Number.isFinite(amount) || amount === 0) throw new Error('Bad bonus');
      const reason = clean(body.reason, 60);
      p.bonuses.push({ amount, reason, at: Date.now() });
      feed('bonus', `${p.name} ${amount > 0 ? 'earns' : 'loses'} ${Math.abs(amount)} points${reason ? ` (${reason})` : ''}`);
      break;
    }
    case 'kick':
      delete state.players[body.playerId];
      break;
    case 'resetTries': {
      const p = state.players[body.playerId];
      if (!p) throw new Error('No such player');
      for (const a of thisRound(p)) if (usesATry(a)) a.forgiven = true;
      p.cooldownUntil = 0;
      break;
    }
    case 'clearCooldown': {
      const p = state.players[body.playerId];
      if (p) p.cooldownUntil = 0;
      break;
    }
    case 'reset': {
      const { players, wifi, vaultOff } = state;
      state = freshState(state.hostKey);
      state.wifi = wifi;
      state.vaultOff = vaultOff;
      if (body.keepPlayers) {
        for (const p of Object.values(players)) {
          state.players[p.id] = { ...p, cards: {}, accusations: [], bonuses: [], vaultGuesses: [], cooldownUntil: 0 };
        }
      }
      break;
    }
    default:
      throw new Error(`Unknown action "${body.action}"`);
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/state') {
    const p = findPlayer(req);
    return send(res, 200, { ...publicState(), me: p ? playerView(p) : null });
  }

  if (route === 'POST /api/join') {
    const body = await readBody(req);
    const name = clean(body.name, 24);
    if (!name) return send(res, 400, { error: 'Tell us your name!' });
    if (playerList().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 400, { error: 'That name is taken. Add an initial or a spooky title!' });
    }
    // A second account on the same phone would get its own clues, accusations and vault
    // tries. Refuse one while a case is on (a lost login uses the host's rejoin link);
    // the host page flags any phone playing as more than one guest.
    const device = deviceOf(req);
    const twin = device && playerList().find((p) => p.device === device);
    if (twin && (state.phase === 'active' || state.phase === 'lastcall')) {
      return send(res, 400, { error: `This phone is already playing as ${twin.name}. Lost your login? Ask the host for your rejoin link.` });
    }
    const p = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      device,
      name,
      costume: clean(body.costume, 40),
      joinedAt: Date.now(),
      cards: {},
      accusations: [],
      bonuses: [],
      cooldownUntil: 0,
    };
    state.players[p.id] = p;
    if (state.phase === 'active' || state.phase === 'lastcall') dealLateJoiner(p);
    feed('join', `${p.name}${p.costume ? ` (${p.costume})` : ''} has entered the manor.`);
    changed();
    return send(res, 200, { token: p.token });
  }

  if (route === 'POST /api/accuse') {
    const p = findPlayer(req);
    if (!p) return send(res, 401, { error: 'Unknown player. Please join again.' });
    const body = await readBody(req);
    const result = accuse(p, body.answer);
    changed();
    return send(res, 200, result);
  }

  if (route === 'POST /api/vault') {
    const p = findPlayer(req);
    if (!p) return send(res, 401, { error: 'Unknown player. Please join again.' });
    const body = await readBody(req);
    const { guess, exact, near, marks, points, found } = tryVault(p, body.guess);
    changed();
    // Only the first opener hears that something was inside; later openers can't tell.
    const wordle = roundVault().style === 'wordle';
    return send(res, 200, { guess, exact, near, points, ...(wordle ? { marks } : {}), ...(found ? { found: true } : {}) });
  }

  if (route === 'GET /api/host') {
    if (!isHost(req)) return send(res, 403, { error: 'Wrong host key' });
    return send(res, 200, { ...publicState(), host: hostView() });
  }

  if (route === 'POST /api/host') {
    if (!isHost(req)) return send(res, 403, { error: 'Wrong host key' });
    hostAction(await readBody(req));
    changed();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
}

const PAGES = { '/': 'index.html', '/board': 'board.html', '/host': 'host.html' };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = PAGES[pathname] || pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(res, url.pathname);
    }
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  const urls = lanUrls();
  const base = urls[0] || `http://localhost:${PORT}/`;
  console.log(`\n🎃  ${mystery.title} is running! (${mystery.cases.length} cases, all verified solvable)\n`);
  console.log(`   Players join at:  ${urls.join('  ') || base}`);
  console.log(`   TV / big screen:  ${base}board`);
  console.log(`   Host controls:    ${base}host?key=${state.hostKey}\n`);
  save();
});
