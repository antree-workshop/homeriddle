'use strict';
// End-to-end test: plays every case of mystery.json through the HTTP API, the way guests
// and the host would. It runs a copy of the game in a temporary folder (its own data/,
// so your real game state is never touched) with timers shortened to seconds.
// Run with `npm test` (about a minute). The one-phone test needs a network address.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'homeriddle-test-'));
const LAN_IP = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
let PORT;
let B;
const KEY = 'testkey';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { failures.push(msg); console.log(`  ❌ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- setup --------------------------------------------------------------------------
for (const f of ['server.js', 'logic.js', 'verify.js', 'mystery.json']) fs.copyFileSync(path.join(REPO, f), path.join(WORK, f));
fs.cpSync(path.join(REPO, 'public'), path.join(WORK, 'public'), { recursive: true });
const mystery = JSON.parse(fs.readFileSync(path.join(REPO, 'mystery.json'), 'utf8'));
const test = structuredClone(mystery);
Object.assign(test.settings, { updateIntervalMinutes: 0.05, lastCallMinutes: 0.05, wrongCooldownSeconds: 1 });
test.settings.vault = { ...test.settings.vault, cooldownSeconds: 1 };
fs.writeFileSync(path.join(WORK, 'test-mystery.json'), JSON.stringify(test));
const SC = test.settings.scoring;
const VAULT_POINTS = test.settings.vault.points;

let server = null;
let log = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: WORK, env: { ...process.env, PORT, HOST_KEY: KEY, MYSTERY: 'test-mystery.json' } });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${B}/api/state`); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start');
}
async function stopServer() {
  const done = new Promise((r) => server.on('exit', r));
  server.kill('SIGTERM');
  await done;
}

async function api(p, { method = 'GET', body, token, host, base = B } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-player-token'] = token;
  if (host !== undefined) headers['x-host-key'] = host;
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const state = async (token) => (await api('/api/state', { token })).json;
const hostState = async () => (await api('/api/host', { host: KEY })).json;
const hostDo = (body) => api('/api/host', { method: 'POST', body, host: KEY });
const join = (name, base) => api('/api/join', { method: 'POST', body: { name }, base });

function feedback(code, guess) {
  let exact = 0, near = 0, marks = '';
  for (let i = 0; i < 4; i++) {
    if (guess[i] === code[i]) { exact++; marks += 'g'; }
    else if (code.includes(guess[i])) { near++; marks += 'y'; }
    else marks += 'x';
  }
  return { exact, near, marks };
}
function wrongGuess(code, seed) {
  // 4 different digits that aren't the code
  const digits = [...'0123456789'];
  for (let s = seed; ; s++) {
    const g = [0, 1, 2, 3].map((k) => digits[(s * 7 + k * 3) % 10]);
    if (new Set(g).size === 4 && g.join('') !== code) return g.join('');
  }
}

// --- tests ----------------------------------------------------------------------------
async function main() {
  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  await startServer();

  console.log('Static files and access');
  for (const p of ['/', '/board', '/host', '/style.css', '/common.js', '/vendor/qrcode.min.js']) {
    ok((await api(p)).status === 200, `GET ${p} should be 200`);
  }
  const images = new Set();
  for (const c of mystery.cases) for (const cat of c.categories) for (const o of cat.options) if (o.image) images.add(o.image);
  let missing = 0;
  for (const img of images) if ((await api(img)).status !== 200) { missing++; ok(false, `image ${img} should load`); }
  ok(missing === 0, 'every image in mystery.json loads');
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/data/state.json', '/../mystery.json']) {
    const r = await api(p);
    ok(r.status !== 200 && !r.text.includes('require('), `${p} must not serve files outside public/`);
  }
  ok((await api('/api/host')).status === 403, 'host API without a key is refused');
  ok((await api('/api/host', { host: 'nope' })).status === 403, 'host API with a wrong key is refused');
  ok((await hostDo({ action: 'finish' })).status === 400, 'ending the night in the lobby is refused');

  console.log('Joining');
  ok((await join('  ')).status === 400, 'an empty name is refused');
  const names = ['Ann', 'Bob', 'Cy', 'Dee', 'Eve'];
  const tok = {};
  for (const n of names) {
    const r = await join(n);
    ok(r.status === 200 && r.json.token, `${n} can join`);
    tok[n] = r.json.token;
  }
  ok((await join('ann')).status === 400, 'a taken name (any case) is refused');
  const long = await join('X'.repeat(60));
  ok(long.status === 200 && (await state(long.json.token)).me.name.length === 24, 'long names are cut to 24 characters');
  const longId = (await state(long.json.token)).me.id;
  await hostDo({ action: 'kick', playerId: longId });
  ok((await state(long.json.token)).me === null, 'a removed player is logged out');
  let s = await state(tok.Ann);
  ok(s.phase === 'lobby' && s.case === null && s.cast.length > 0, 'lobby shows the cast and no case');
  ok(s.leaderboard.length === 5, 'leaderboard lists the 5 players');

  for (let ci = 0; ci < mystery.cases.length; ci++) {
    const c = mystery.cases[ci];
    console.log(`Case ${ci + 1}: ${c.title}`);
    const r0 = ci === 0 ? await hostDo({ action: 'start' }) : await hostDo({ action: 'next' });
    ok(r0.status === 200, 'host starts the case');
    await hostDo({ action: 'pause' }); // updates on demand from here
    const startedAt = Date.now();

    // What phones see
    s = await state(tok.Ann);
    ok(s.phase === 'active' && s.caseIndex === ci, 'case is active');
    ok(s.case.title === c.title, 'phones get the case');
    const publicJson = JSON.stringify(await state());
    const secretTexts = c.clues.filter((x) => !x.public).map((x) => x.text);
    ok(secretTexts.every((t) => !publicJson.includes(t)), 'no secret or golden clue text in the public state');
    ok(!publicJson.includes('"solution":{') && s.case.solution === null, 'no solution before the reveal');
    const visual = new Set(c.categories.flatMap((cat) => (cat.traits || []).filter((t) => t.visual).map((t) => t.key)));
    const sentTraits = new Set(s.case.categories.flatMap((cat) => cat.options.flatMap((o) => Object.keys(o.traits || {}))));
    ok([...visual].every((k) => !sentTraits.has(k)), 'picture-only traits are not sent');
    ok(s.case.facts.length === c.clues.filter((x) => x.public && !(x.release || 0)).length, 'case file has the starting public clues');
    const h = await hostState();
    ok(!publicJson.includes(`"${h.host.vault.code}"`), 'vault code not in the public state');

    // Dealing
    const hands = {};
    for (const n of names) hands[n] = (await state(tok[n])).me.cards;
    ok(names.every((n) => hands[n].length >= 1), 'every player got at least one secret clue');
    const startSecrets = c.clues.filter((x) => !x.public && !x.vault && !(x.release || 0)).map((x) => x.text);
    const dealt = new Set(names.flatMap((n) => hands[n].map((x) => x.text)));
    ok(startSecrets.every((t) => dealt.has(t)), 'every starting secret clue was dealt to someone');
    ok([...dealt].every((t) => startSecrets.includes(t)), 'only starting secret clues were dealt');

    // Vault
    const code = h.host.vault.code;
    const style = h.host.vault.style;
    ok(style === (ci % 2 === 0 ? 'mastermind' : 'wordle'), `vault style alternates (${style})`);
    ok(/^\d{4}$/.test(code) && new Set(code).size === 4, 'vault code is 4 different digits');
    ok((await api('/api/vault', { method: 'POST', token: tok.Ann, body: { guess: '1123' } })).status === 400, 'repeated digits are refused');
    ok((await api('/api/vault', { method: 'POST', token: tok.Ann, body: { guess: '12a4' } })).status === 400, 'non-digits are refused');
    const g1 = wrongGuess(code, ci);
    const v1 = (await api('/api/vault', { method: 'POST', token: tok.Ann, body: { guess: g1 } })).json;
    const exp = feedback(code, g1);
    ok(v1.exact === exp.exact && v1.near === exp.near, `vault feedback counts are right (${g1} vs code)`);
    ok(style === 'wordle' ? v1.marks === exp.marks : v1.marks === undefined, 'per-digit marks only in wordle style');
    const tooSoon = await api('/api/vault', { method: 'POST', token: tok.Ann, body: { guess: wrongGuess(code, ci + 5) } });
    ok(tooSoon.status === 400 && /settling/.test(tooSoon.json.error), 'vault cooldown applies');
    const sv = (await state(tok.Ann)).me.vault;
    ok(sv.guesses.length === 1 && (style === 'wordle') === ('marks' in sv.guesses[0]), 'guess history kept, marks only in wordle');
    await sleep(1100);
    const vAnn = (await api('/api/vault', { method: 'POST', token: tok.Ann, body: { guess: code } })).json;
    ok(vAnn.exact === 4 && vAnn.points === VAULT_POINTS && vAnn.found === true, 'first opener gets points and finds the golden clue');
    const vBob = (await api('/api/vault', { method: 'POST', token: tok.Bob, body: { guess: code } })).json;
    ok(vBob.exact === 4 && vBob.points === VAULT_POINTS && vBob.found === undefined, 'second opener gets the same points, no hint it was emptied');
    const again = await api('/api/vault', { method: 'POST', token: tok.Bob, body: { guess: code } });
    ok(again.status === 400, 'a vault can only be opened once per player');
    const golden = c.clues.filter((x) => x.vault).map((x) => x.text);
    const annCards = (await state(tok.Ann)).me.cards;
    ok(golden.every((t) => annCards.some((x) => x.text === t && x.vault)), 'Ann holds the golden clue');
    ok(!(await state(tok.Bob)).me.cards.some((x) => x.vault), 'Bob does not get the golden clue');
    s = await state(tok.Ann);
    const annBoard = s.leaderboard.find((p) => p.name === 'Ann').score;
    ok(s.me.vaultPending === VAULT_POINTS && s.me.score === annBoard + VAULT_POINTS, 'vault points hidden from the leaderboard, shown to the opener');
    ok(s.vault.lastAttemptAt > 0, 'TV learns someone tried the vault');
    const hv = await hostState();
    ok(hv.host.players.find((p) => p.name === 'Ann').score === s.me.score, 'host sees full scores');

    // Wrong accusations
    const sol = c.solution;
    const keys = c.categories.map((cat) => cat.key);
    const wrong = { ...sol, [keys[0]]: c.categories[0].options.find((o) => o.id !== sol[keys[0]]).id };
    ok((await api('/api/accuse', { method: 'POST', token: tok.Cy, body: { answer: { [keys[0]]: sol[keys[0]] } } })).status === 400, 'an incomplete accusation is refused');
    const w1 = (await api('/api/accuse', { method: 'POST', token: tok.Cy, body: { answer: wrong } })).json;
    ok(w1.correct === false && w1.points === -SC.wrongPenalty, 'wrong accusation costs points');
    ok((await api('/api/accuse', { method: 'POST', token: tok.Cy, body: { answer: wrong } })).status === 400, 'accusation cooldown applies');
    for (let k = 0; k < 3; k++) {
      await api('/api/accuse', { method: 'POST', token: tok.Dee, body: { answer: wrong } });
      await sleep(1050);
    }
    const out = await api('/api/accuse', { method: 'POST', token: tok.Dee, body: { answer: sol } });
    ok(out.status === 400 && /out of accusations/.test(out.json.error), 'max 3 wrong accusations per case');
    ok((await state(tok.Dee)).me.accusationsLeft === 0, 'phone shows no accusations left');
    if (ci === 0) {
      const dee = (await state(tok.Dee)).me;
      ok((await hostDo({ action: 'resetTries', playerId: 'nobody' })).status === 400, 'reset tries for an unknown player is refused');
      ok((await hostDo({ action: 'resetTries', playerId: dee.id })).status === 200, 'host resets Dee\'s tries');
      const after = (await state(tok.Dee)).me;
      ok(after.accusationsLeft === 3 && after.cooldownUntil === 0, 'reset gives all 3 tries back and clears the cooldown');
      ok(after.score === dee.score, 'reset keeps the points the wrong guesses cost');
      ok(after.accusations.filter((a) => a.forgiven).length === 3, 'phone sees the tries were given back');
      const host = (await hostState()).host.players.find((p) => p.id === dee.id);
      ok(host.accusations.every((a) => a.forgiven), 'host page sees the given-back tries');
    }

    // Updates
    if (ci === 0) {
      await hostDo({ action: 'resume' });
      await sleep(4600);
      ok((await state()).case.updates.length === 1, 'an update drops automatically on the timer');
      await hostDo({ action: 'pause' });
      await sleep(4600);
      ok((await state()).case.updates.length === 1, 'no update while paused');
    }
    const total = (await state()).case.totalUpdates;
    ok(total === Math.max(...c.clues.filter((x) => !x.vault).map((x) => x.release || 0)), 'update count ignores golden clues');
    while ((await state()).case.updates.length < total) {
      const before = (await state()).case.updates.length;
      ok((await hostDo({ action: 'update' })).status === 200, `host releases update ${before + 1}`);
      const st = await state();
      const u = st.case.updates[before];
      const pubTexts = c.clues.filter((x) => x.public && x.release === u.number).map((x) => x.text);
      ok(JSON.stringify(u.clues) === JSON.stringify(pubTexts), `update ${u.number} shows its public clues`);
      const secrets = c.clues.filter((x) => !x.public && !x.vault && x.release === u.number).map((x) => x.text);
      ok(u.receivers.length === secrets.length, `update ${u.number}: ${secrets.length} named receiver(s)`);
      for (const n of u.receivers) {
        const cards = (await state(tok[n])).me.cards;
        ok(cards.some((x) => x.release === u.number && secrets.includes(x.text)), `${n} got the secret evidence of update ${u.number}`);
      }
    }
    ok((await hostDo({ action: 'update' })).status === 400, 'no updates beyond the last');

    // Late joiner (case 2 only)
    if (ci === 1) {
      const fay = await join('Fay');
      ok(fay.status === 200, 'a late joiner can join from the server machine');
      const fc = (await state(fay.json.token)).me.cards;
      ok(fc.length > 0 && fc.length <= test.settings.lateJoinerCards && fc.every((x) => !x.vault), 'late joiner gets up to 2 released clues, never the golden one');
      await hostDo({ action: 'kick', playerId: (await state(fay.json.token)).me.id });
    }

    // Restart mid-case (case 3): everything must survive
    if (ci === 2) {
      const bonusP = (await hostState()).host.players.find((p) => p.name === 'Eve').id;
      await hostDo({ action: 'bonus', playerId: bonusP, amount: 25, reason: 'Best costume' });
      const before = await hostState();
      await stopServer(); // straight after a change: tests the save on shutdown
      await startServer();
      const after = await hostState();
      const snap = (x) => JSON.stringify({ phase: x.phase, case: x.case && { ...x.case, nextUpdateAt: 0 }, players: x.host.players, vault: x.host.vault });
      ok(snap(before) === snap(after), 'a restart keeps players, scores, hands, vault and case');
      ok(after.feed.some((f) => /Best costume/.test(f.text)), 'host bonus shows in the feed');
    }
    ok((await hostDo({ action: 'bonus', playerId: 'nobody', amount: 5 })).status === 400, 'bonus for an unknown player is refused');

    // Solving
    const nUpdates = (await state()).case.updates.length;
    const first = (await api('/api/accuse', { method: 'POST', token: tok.Eve, body: { answer: sol } })).json;
    const expFirst = Math.max(SC.minCorrect, SC.correctBase - SC.perUpdatePenalty * nUpdates) + SC.firstSolverBonus;
    ok(first.correct && first.points === expFirst, `first solver gets ${expFirst}`);
    s = await state();
    ok(s.phase === 'lastcall' && s.case.solvers[0].name === 'Eve', 'last call starts, Eve named');
    ok((await api('/api/accuse', { method: 'POST', token: tok.Eve, body: { answer: sol } })).status === 400, 'cannot solve twice');
    const second = (await api('/api/accuse', { method: 'POST', token: tok.Bob, body: { answer: sol } })).json;
    ok(second.correct && second.points === Math.round(Math.max(SC.minCorrect, SC.correctBase - SC.perUpdatePenalty * nUpdates) * SC.lastCallMultiplier), 'last call gives half points, no bonus');

    if (ci === 1) {
      await hostDo({ action: 'reveal' });
      ok((await state()).phase === 'revealed', 'host can reveal early');
    } else if (ci === 3) {
      for (const n of ['Ann', 'Cy']) {
        await sleep(1100);
        await api('/api/accuse', { method: 'POST', token: tok[n], body: { answer: sol } });
      }
      s = await state();
      ok(s.phase === 'lastcall', 'still last call while Dee (out of tries) has not solved');
      await sleep(4600);
      ok((await state()).phase === 'revealed', 'last call ends on its own');
    } else {
      await sleep(4600);
      ok((await state()).phase === 'revealed', 'last call ends on its own');
    }
    s = await state(tok.Ann);
    ok(s.case.solution && s.case.solution.answer[keys[0]] === sol[keys[0]], 'solution shown after the reveal');
    ok(s.me.vaultPending === 0 && s.leaderboard.find((p) => p.name === 'Ann').score === s.me.score, 'vault points join the leaderboard at the reveal');
    ok((await api('/api/vault', { method: 'POST', token: tok.Cy, body: { guess: code } })).status === 400, 'vault closed after the reveal');
    ok((await api('/api/accuse', { method: 'POST', token: tok.Cy, body: { answer: sol } })).status === 400, 'accusations closed after the reveal');
    console.log(`  (${Math.round((Date.now() - startedAt) / 1000)} s)`);
  }

  console.log('End of the night');
  ok((await hostDo({ action: 'next' })).status === 200, 'host ends the night after the last case');
  s = await state(tok.Ann);
  ok(s.phase === 'finished' && s.case && s.leaderboard.length === 5, 'final state renders with a case and leaderboard');
  const scores = Object.fromEntries(s.leaderboard.map((p) => [p.name, p.score]));
  console.log('  final scores:', JSON.stringify(scores));
  ok(s.leaderboard.every((p, i, a) => i === 0 || a[i - 1].score >= p.score), 'leaderboard is sorted');

  console.log('Replay and reset');
  ok((await hostDo({ action: 'start', caseIndex: 0 })).status === 200, 'host can replay case 1');
  s = await state(tok.Cy);
  ok(s.phase === 'active' && s.me.accusations.length === 0 && s.me.accusationsLeft === 3 && s.me.vault.guesses.length === 0, 'replay starts guesses fresh');
  ok(s.leaderboard.find((p) => p.name === 'Ann').score === scores.Ann, 'replay keeps points already earned');

  if (LAN_IP) {
    const lan = `http://${LAN_IP}:${PORT}`;
    const p1 = await join('Phone1', lan);
    ok(p1.status === 200, 'a phone joins during a case');
    const p2 = await join('Phone2', lan);
    ok(p2.status === 400 && /already playing as Phone1/.test(p2.json.error), 'a second account from the same phone is refused during a case');
    await hostDo({ action: 'reveal' });
    const p3 = await join('Phone3', lan);
    ok(p3.status === 200, 'outside a case the same phone may join again');
    const flagged = (await hostState()).host.players.find((p) => p.name === 'Phone3');
    ok(flagged.sameDevice.includes('Phone1'), 'host page flags the shared phone');
  } else console.log('  (no LAN address: skipped the one-phone test)');

  ok((await hostDo({ action: 'interval', minutes: 0 })).status === 400, 'a silly update interval is refused');
  ok((await hostDo({ action: 'bogus' })).status === 400, 'unknown host actions are refused');
  await hostDo({ action: 'reset', keepPlayers: true });
  s = await state(tok.Ann);
  ok(s.phase === 'lobby' && s.me && s.leaderboard.every((p) => p.score === 0), 'restart (keep players) zeroes scores');
  await hostDo({ action: 'reset' });
  ok((await state(tok.Ann)).me === null && (await state()).leaderboard.length === 0, 'wipe everything removes players');

  await stopServer();
  const problems = log.split('\n').filter((l) => /error|exception|⚠️|warn/i.test(l));
  ok(problems.length === 0, `server log is clean${problems.length ? `: ${problems.join(' | ')}` : ''}`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    if (server) server.kill();
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(WORK, { recursive: true, force: true }));
