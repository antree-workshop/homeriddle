'use strict';

// Murdle-style logic engine.
//
// The first category of a case holds the suspects. Every suspect is paired with
// exactly one option of every other category (one weapon, one location, ...),
// and exactly one suspect is the murderer. A "world" is one such arrangement.
// Clues carry an optional machine-readable `rule`; brute-forcing every world
// tells us whether the puzzle has exactly one answer and how fast it narrows.
//
// Rule language (all JSON):
//   references   "who:grimm"            one option (category key : option id)
//                {"who": {"hat": true}}  every option whose traits match
//                "murderer" / "culprit"  the guilty suspect
//   {"with": [A, B]}        everything matched by A was together with something matched by B
//   {"apart": [A, B]}       nothing matched by A was together with anything matched by B
//   {"not": R}  {"and": [R...]}  {"or": [R...]}  {"if": R, "then": R}
//   {"exactly": 2, "of": [R, R, R]}   e.g. two truths and a lie
//   {"says": "who:crane", "that": R}  testimony: true unless the speaker is the murderer

function permutations(n) {
  const out = [];
  const a = [...Array(n).keys()];
  const rec = (k) => {
    if (k === n) return out.push(a.slice());
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      rec(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  rec(0);
  return out;
}

function compileRule(c, rule, where) {
  const catIndex = (key) => {
    const i = c.categories.findIndex((cat) => cat.key === key);
    if (i < 0) throw new Error(`${where}: unknown category "${key}"`);
    return i;
  };

  // A reference becomes { murderer: true } or { cat, set } (set of option indices).
  const ref = (r) => {
    if (r === 'murderer' || r === 'culprit') return { murderer: true, cat: 0 };
    if (typeof r === 'string') {
      const [key, id] = r.split(':');
      const ci = catIndex(key);
      const oi = c.categories[ci].options.findIndex((o) => o.id === id);
      if (oi < 0) throw new Error(`${where}: unknown option "${r}"`);
      return { cat: ci, set: new Set([oi]) };
    }
    if (r && typeof r === 'object' && Object.keys(r).length === 1) {
      const [key] = Object.keys(r);
      const ci = catIndex(key);
      const filter = r[key];
      const set = new Set();
      c.categories[ci].options.forEach((o, oi) => {
        if (Object.entries(filter).every(([k, v]) => (o.traits || {})[k] === v)) set.add(oi);
      });
      if (!set.size) throw new Error(`${where}: ${JSON.stringify(r)} matches nothing`);
      return { cat: ci, set };
    }
    throw new Error(`${where}: bad reference ${JSON.stringify(r)}`);
  };

  const compile = (r) => {
    if (!r || typeof r !== 'object') throw new Error(`${where}: bad rule ${JSON.stringify(r)}`);
    if (r.with) {
      const [a, b] = r.with.map(ref);
      const aSet = a.murderer ? null : [...a.set];
      return (w) => {
        const people = a.murderer ? [w.m] : aSet.map((o) => w.inv[a.cat][o]);
        return people.every((p) => (b.murderer ? p === w.m : b.set.has(w.pos[b.cat][p])));
      };
    }
    if (r.apart) {
      const [a, b] = r.apart.map(ref);
      const aSet = a.murderer ? null : [...a.set];
      return (w) => {
        const people = a.murderer ? [w.m] : aSet.map((o) => w.inv[a.cat][o]);
        return people.every((p) => (b.murderer ? p !== w.m : !b.set.has(w.pos[b.cat][p])));
      };
    }
    if ('not' in r) {
      const f = compile(r.not);
      return (w) => !f(w);
    }
    if (r.and) {
      const fs = r.and.map(compile);
      return (w) => fs.every((f) => f(w));
    }
    if (r.or) {
      const fs = r.or.map(compile);
      return (w) => fs.some((f) => f(w));
    }
    if (r.if) {
      const f = compile(r.if);
      const g = compile(r.then);
      return (w) => !f(w) || g(w);
    }
    if (r.exactly != null) {
      const fs = r.of.map(compile);
      return (w) => fs.filter((f) => f(w)).length === r.exactly;
    }
    if (r.says) {
      const s = ref(r.says);
      if (s.cat !== 0 || s.set.size !== 1) throw new Error(`${where}: "says" needs a single suspect`);
      const speaker = [...s.set][0];
      const f = compile(r.that);
      return (w) => f(w) === (w.m !== speaker);
    }
    throw new Error(`${where}: unknown rule ${JSON.stringify(r)}`);
  };

  return compile(rule);
}

// Every possible world for a case (n suspects, n options in each other category).
function* worlds(c) {
  const n = c.categories[0].options.length;
  const perms = permutations(n);
  const identity = [...Array(n).keys()];
  const k = c.categories.length;
  const pos = [identity];
  const inv = [identity];
  function* rec(ci) {
    if (ci === k) {
      for (let m = 0; m < n; m++) yield { m, pos, inv };
      return;
    }
    for (const p of perms) {
      pos[ci] = p;
      const q = [];
      p.forEach((o, person) => (q[o] = person));
      inv[ci] = q;
      yield* rec(ci + 1);
    }
  }
  yield* rec(1);
}

function answerKey(c, w) {
  return c.categories.map((cat, ci) => cat.options[w.pos[ci][w.m]].id).join('|');
}

// For each update (0 = start), count the possible answers if players had pooled
// (a) every clue released so far, and (b) only the public clues.
function analyzeCase(c, where) {
  const errors = [];
  const warnings = [];
  const n = c.categories[0].options.length;
  for (const cat of c.categories) {
    if (cat.options.length !== n) errors.push(`${where}: every category needs ${n} options (like "${c.categories[0].key}")`);
  }
  if (c.categories.length > 3 || n > 6) errors.push(`${where}: keep it to 3 categories of at most 6 options`);
  if (errors.length) return { errors, warnings };

  const compiled = [];
  c.clues.forEach((clue, i) => {
    if (!clue.rule || clue.vault) return; // golden clues are checked separately below
    try {
      compiled.push({ i, release: clue.release || 0, public: !!clue.public, f: compileRule(c, clue.rule, `${where} clue ${i + 1}`) });
    } catch (err) {
      errors.push(err.message);
    }
  });
  if (errors.length) return { errors, warnings };

  const updates = Math.max(0, ...c.clues.filter((x) => !x.vault).map((x) => x.release || 0));
  const all = Array.from({ length: updates + 1 }, () => new Map());
  const pub = Array.from({ length: updates + 1 }, () => new Map());
  const firstBroken = new Map(); // clue index -> true if it contradicts the solution

  const solutionKey = c.categories.map((cat) => c.solution[cat.key]).join('|');
  let solutionWorlds = 0;

  for (const w of worlds(c)) {
    const key = answerKey(c, w);
    // Earliest stage at which this world is ruled out, for each mode.
    let deadAll = Infinity;
    let deadPub = Infinity;
    for (const x of compiled) {
      if (x.release >= deadAll && (!x.public || x.release >= deadPub)) continue;
      if (!x.f(w)) {
        deadAll = Math.min(deadAll, x.release);
        if (x.public) deadPub = Math.min(deadPub, x.release);
      }
    }
    if (key === solutionKey && deadAll === Infinity) solutionWorlds++;
    for (let s = 0; s <= updates; s++) {
      if (s < deadAll) all[s].set(key, (all[s].get(key) || 0) + 1);
      if (s < deadPub) pub[s].set(key, (pub[s].get(key) || 0) + 1);
    }
  }

  if (!solutionWorlds) {
    errors.push(`${where}: the stated solution (${solutionKey.replace(/\|/g, ' / ')}) contradicts the clues`);
  }
  const finalAll = all[updates];
  if (finalAll.size > 1) {
    warnings.push(`${where}: even with every clue, ${finalAll.size} answers remain: ${[...finalAll.keys()].join(', ')}`);
  }
  if (pub[updates].size > 1) {
    warnings.push(`${where}: public clues alone leave ${pub[updates].size} answers. Players must share secrets to solve it.`);
  }
  if (all[0].size === 1 && updates > 0) {
    warnings.push(`${where}: the starting clues already pin down the answer; later updates only speed things up`);
  }
  const unverified = c.clues.filter((x) => !x.rule).length;
  if (unverified) warnings.push(`${where}: ${unverified} clue(s) have no rule and were not checked`);

  // Golden clues (won from the vault, any time during the case) must agree with the
  // solution. For each update, also count the answers left if the vault's owner pools
  // everything too: that shows how big a shortcut the vault is.
  const golden = c.clues.filter((x) => x.vault);
  let withGolden = null;
  if (golden.length) {
    for (const x of golden) if (x.public) errors.push(`${where}: a golden (vault) clue can't be public`);
    const regular = c.clues.filter((x) => !x.vault);
    withGolden = analyzeCase({ ...c, clues: [...regular, ...golden.map((x) => ({ ...x, vault: false, public: false, release: 0 }))] }, `${where} (with the golden clue)`);
    errors.push(...withGolden.errors);
  }

  return {
    errors,
    warnings,
    stages: all.map((m, s) => ({
      answersAllGolden: withGolden && withGolden.stages ? withGolden.stages[s].answersAll : null,
      update: s,
      answersAll: m.size,
      answersPublic: pub[s].size,
      remainingAll: m.size <= 6 ? [...m.keys()] : null,
      remainingPublic: pub[s].size <= 6 ? [...pub[s].keys()] : null,
    })),
  };
}

module.exports = { analyzeCase, compileRule };
