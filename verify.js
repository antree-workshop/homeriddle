'use strict';

// Checks a mystery file: `node verify.js [mystery.json] [--verbose]`
// For every case it prints how many answers are still possible after each update,
// assuming players pooled all clues released so far ("everything") or only the public ones.

const fs = require('node:fs');
const path = require('node:path');
const { analyzeCase } = require('./logic');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'mystery.json'));
const mystery = JSON.parse(fs.readFileSync(file, 'utf8'));
let failed = false;

mystery.cases.forEach((c, i) => {
  const where = `Case ${i + 1} "${c.title}"`;
  const a = analyzeCase(c, where);
  console.log(`\n${where}`);
  if (a.stages) {
    const secrets = (s) => c.clues.filter((x) => !x.public && !x.vault && (x.release || 0) === s).length;
    const publics = (s) => c.clues.filter((x) => x.public && (x.release || 0) === s).length;
    console.log('  update | new public | new secret | answers left (everything) | (public only)');
    for (const st of a.stages) {
      const label = st.update === 0 ? 'start' : `#${st.update}`;
      const list = (xs) => (xs ? xs.map((x) => x.replace(/\|/g, '/')).join(', ') : '');
      if (verbose) console.log(`         everything: ${list(st.remainingAll)}\n         public: ${list(st.remainingPublic)}`);
      console.log(`  ${label.padEnd(6)} | ${String(publics(st.update)).padEnd(10)} | ${String(secrets(st.update)).padEnd(10)} | ${String(st.answersAll).padEnd(25)} | ${st.answersPublic}`);
    }
  }
  if (a.stages && a.stages[0].answersAllGolden != null) {
    console.log(`  🔐 golden clue: answers left (everything + vault) ${a.stages.map((st) => st.answersAllGolden).join(' → ')}`);
  }
  for (const w of a.warnings) console.log(`  ⚠️  ${w}`);
  for (const e of a.errors) console.log(`  ❌ ${e}`);
  if (a.errors.length) failed = true;
});

// The TV lobby's lineup must name real suspects, or the server won't start.
for (const pick of mystery.lobbyCast || []) {
  const cat = mystery.cases[pick.case - 1]?.categories?.[0];
  if (!cat || !(cat.options || []).some((o) => o.id === pick.id)) {
    console.log(`\n  ❌ lobbyCast: case ${pick.case} has no suspect "${pick.id}"`);
    failed = true;
  }
}

console.log(failed ? '\n❌ Fix the errors above.' : '\n✅ All cases check out.');
process.exit(failed ? 1 : 0);
