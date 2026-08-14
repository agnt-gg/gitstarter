// Reintroduces each rent-reclamation bug and confirms the suite catches it.
// A guard that cannot fail is not a guard.
//
// The file is restored on ANY exit, including a kill. An earlier version only
// restored on the happy path, was killed mid-run, and left a guard stubbed out
// as `let settled = true` — which the next run then read as its own baseline and
// saved back. A harness that edits source has to be crash-safe or it becomes the
// bug it is looking for.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const cwd = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/rent/program';
const file = `${cwd}/src/lib.rs`;
const original = fs.readFileSync(file, 'utf8');

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  if (fs.readFileSync(file, 'utf8') !== original) fs.writeFileSync(file, original);
};
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => { restore(); process.exit(130); });
}
process.on('uncaughtException', error => { restore(); console.error(error); process.exit(1); });

const run = () => {
  try { execFileSync('cargo', ['test', '--test', 'adversarial'], { cwd, stdio: 'pipe' }); return true; }
  catch { return false; }
};

const cases = {
  'let ClosePledge run on a live commission':
    [/let settled =\s*\r?\n?\s*p\.fully_refunded \|\| \(c\.status == Status::Delivered && c\.escrow_remaining\(\)\? == 0\);/,
      'let settled = true;'],
  'let CloseVault run while escrow is still held':
    [/    if c\.escrow_remaining\(\)\? != 0 \{\r?\n        return Err\(EscrowError::NotSettled\.into\(\)\);\r?\n    \}/, ''],
  'let CloseVault run before every backer has settled':
    [/    if c\.status == Status::Cancelled && c\.refunded_pledger_count != c\.pledger_count \{\r?\n        return Err\(EscrowError::NotSettled\.into\(\)\);\r?\n    \}/, ''],
  // Anchored on close_vault's own comment: `if c.creator != *creator.key` also
  // appears in select_agent and reject_delivery, and a bare pattern replaces the
  // FIRST match, silently mutating a function this suite is not measuring.
  'let the vault rent be redirected away from the creator':
    [/anyone may run this as a cleanup crank without anything to gain by it\.\r?\n    if c\.creator != \*creator\.key \{\r?\n        return Err\(EscrowError::Unauthorized\.into\(\)\);\r?\n    \}/,
      'anyone may run this as a cleanup crank without anything to gain by it.'],
  'stop closing the pledge on refund':
    [/    let reclaimed = pledge_ai\.lamports\(\);\r?\n    close_account\(pledge_ai, backer\)\?;/,
      '    let reclaimed = 0u64;'],
  'let a settled pledge be topped up again':
    [/        if existing\.fully_refunded \{\r?\n            return Err\(EscrowError::NothingToRefund\.into\(\)\);\r?\n        \}/, ''],
};

// Verified separately with _probe_one.cjs, which applies a single mutation and
// runs only the test that should catch it:
//   - the close_vault creator check IS measured (test fails when removed)
//   - three guards are defence-in-depth: removing any one leaves another that
//     fires first, so the mutation is undetectable BY DESIGN rather than by a
//     weak test. Specifically: CloseVault's escrow check overlaps its
//     settled-pledger check, and pledge()'s fully_refunded guard sits behind the
//     status check that already makes the state unreachable.
console.log(`clean suite: ${run() ? 'PASS' : 'FAIL'}`);
let missed = 0;
for (const [label, [find, replace]] of Object.entries(cases)) {
  const mutated = original.replace(find, replace);
  if (mutated === original) { console.log(`SETUP-FAIL  ${label}`); missed++; continue; }
  fs.writeFileSync(file, mutated);
  const caught = !run();
  fs.writeFileSync(file, original);
  if (!caught) missed++;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${label}`);
}
restore();
console.log(`\nrestored: ${fs.readFileSync(file, 'utf8') === original}`);
console.log(`missed: ${missed}`);
