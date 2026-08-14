// Applies ONE mutation and runs ONLY the test that should catch it, with full
// output, so a "MISSED" is diagnosed instead of guessed at.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const cwd = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/rent/program';
const file = `${cwd}/src/lib.rs`;
const original = fs.readFileSync(file, 'utf8');
const restore = () => { if (fs.readFileSync(file, 'utf8') !== original) fs.writeFileSync(file, original); };
process.on('exit', restore);
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => { restore(); process.exit(130); });

const anchor = `    // The rent goes to whoever paid for the account, never to the caller, so
    // anyone may run this as a cleanup crank without anything to gain by it.
    if c.creator != *creator.key {
        return Err(EscrowError::Unauthorized.into());
    }
`;
if (!original.includes(anchor)) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
fs.writeFileSync(file, original.replace(anchor, ''));
console.log('mutation applied: close_vault no longer checks the creator\n');

try {
  const out = execFileSync('cargo', ['test', '--test', 'adversarial', 'a_vault_holding_escrow'], { cwd, encoding: 'utf8', stdio: 'pipe' });
  console.log(out.split('\n').filter(l => /test result|panicked|assert|running \d/i.test(l)).join('\n'));
  console.log('\n>>> TEST PASSED WITH THE GUARD REMOVED - the assertion is not measuring it');
} catch (error) {
  const text = `${error.stdout || ''}${error.stderr || ''}`;
  console.log(text.split('\n').filter(l => /test result|panicked|assertion|redirect/i.test(l)).join('\n'));
  console.log('\n>>> TEST FAILED - the guard IS measured');
}
restore();
console.log('restored:', fs.readFileSync(file, 'utf8') === original);
