// Reintroduces each notification bug and confirms the suite catches it.
// Restores on ANY exit, including a kill: a harness that edits source and only
// cleans up on the happy path becomes the bug it is hunting.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/notify';
const files = {
  escrow: `${root}/shared/escrow.js`,
  client: `${root}/client/app.js`,
  html: `${root}/index.html`,
};
const original = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

let done = false;
const restore = () => {
  if (done) return;
  done = true;
  for (const [k, p] of Object.entries(files)) {
    if (fs.readFileSync(p, 'utf8') !== original[k]) fs.writeFileSync(p, original[k]);
  }
};
process.on('exit', restore);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { restore(); process.exit(130); });
process.on('uncaughtException', e => { restore(); console.error(e); process.exit(1); });

const run = () => {
  try { execFileSync('node', ['--test', 'server/test/attention.test.js'], { cwd: root, stdio: 'pipe' }); return true; }
  catch { return false; }
};

const cases = [
  ['escrow', 'THE BUG: stop telling a creator work was delivered',
    /  if \(isCreator && c\.submission && !matured\) \{[\s\S]*?\r?\n  \}\r?\n/, ''],
  ['escrow', 'downgrade a running review clock to background noise',
    /      kind: 'review',\r?\n      urgency: 'act',/, "      kind: 'review',\r\n      urgency: 'idle',"],
  ['escrow', 'nag the agent about their own pending submission',
    /  if \(isCreator && c\.submission && !matured\) \{/, '  if (c.submission && !matured) {'],
  ['escrow', 'let rent compete with a running clock',
    /      kind: 'rent',\r?\n      urgency: 'idle',/, "      kind: 'rent',\r\n      urgency: 'act',"],
  ['escrow', 'raise attention for people with nothing to do',
    /  if \(!wallet\) return null;/, '  if (!wallet) return null;\n  if (wallet) return { kind: "noise", urgency: "act", label: "x", detail: "y", deadline: null };'],
  ['escrow', 'drop the milestone number from the label',
    /label: `Milestone \$\{c\.submission\.milestoneIndex \+ 1\} delivered/, 'label: `Work delivered'],
  ['client', 'announce every push, changed or not',
    /if\(after&&after\.urgency==='act'&&key\(after\)!==before\)/, "if(after&&after.urgency==='act')"],
  ['client', 'key the announcement on category alone (swallows a 2nd delivery)',
    /`\$\{attention\.kind\}:\$\{attention\.label\}`/, '`${attention.kind}`'],
  ['client', 'request notification permission on page load',
    /  await restoreSession\(\);/, '  offerNotifications();\n  await restoreSession();'],
  ['client', 'remove the attention badge from the row',
    /\$\{attention\?`<span class="lbl attention \$\{attention\.urgency\}">/, '${false?`<span class="lbl attention ${attention.urgency}">'],
  ['client', 'show the needs-you tab even when empty',
    /\+\(needsYou\.length\?`<button data-f="needs-you"/, '+(true?`<button data-f="needs-you"'],
  ['html', 'drop the attention badge styling',
    /\.lbl\.attention\.act\{background[^}]*\}/, '.lbl.attention.act{}'],
];

console.log(`clean suite: ${run() ? 'PASS' : 'FAIL'}`);
let missed = 0;
for (const [file, label, find, replace] of cases) {
  const mutated = original[file].replace(find, replace);
  if (mutated === original[file]) { console.log(`SETUP-FAIL  ${label}`); missed++; continue; }
  fs.writeFileSync(files[file], mutated);
  const caught = !run();
  fs.writeFileSync(files[file], original[file]);
  if (!caught) missed++;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${label}`);
}
restore();
console.log(`\nrestored: ${Object.entries(files).every(([k, p]) => fs.readFileSync(p, 'utf8') === original[k])}`);
console.log(`missed: ${missed}`);
