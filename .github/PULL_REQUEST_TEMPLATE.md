## What this changes

<!-- One paragraph. What breaks without it, or what becomes possible with it. -->

## How it is verified

<!-- Every bug fix ships with the test that would have caught it. Name the
     test, and say what you ran locally: `npm test`, `cargo test` in program/,
     or both. "It works" is not a verification. -->

## Checklist

- [ ] `npm test` passes locally
- [ ] If `client/app.js` changed: `npm run build:client` was run and the rebuilt `public/app.js` is committed (CI and the deploy gate both reject a stale bundle)
- [ ] If `program/src/lib.rs` changed: `cargo test` passes in `program/`, and I understand the deployed binary only changes via a 2-of-3 multisig upgrade
- [ ] If an API shape, instruction, account layout, or error code changed: `README.md` and `server/llms.template.txt` are updated (the docs tests fail on drift)
- [ ] No secrets, keypairs, or RPC keys anywhere in the diff
