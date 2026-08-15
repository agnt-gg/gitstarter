# Push-to-deploy

GitStarter uses the same deployment shape as `agnt-server`: one named remote with two push URLs.

```bat
set "GIT_SSH_COMMAND=ssh -i C:/Users/Studio/.ssh/agnt_do -o IdentitiesOnly=yes -o BatchMode=yes"
git push production main
```

`production` pushes sequentially to:

1. `root@agnt.gg:/root/gitstarter.git` — server-side deploy hook.
2. `https://github.com/agnt-gg/gitstarter.git` — public source mirror.

The server hook stages the exact pushed tree and then **fails closed on the two mistakes that have actually shipped**:

1. **A stale bundle is a rejected push.** The stage rebuilds `public/app.js` with `npm run build:client` and compares it byte-for-byte against the committed file. A correct source fix with a stale committed bundle — which shipped twice, silently — now bounces with instructions instead of deploying old code.
2. **The stage runs the dependency tree the revision declares.** If `package-lock.json` differs from live's (or the build tools are missing), the stage gets its own `npm ci`; live `node_modules` is reused only when the lockfile is byte-identical. On success the staged tree is rsynced into live in the same deploy as the code that needs it, so a new dependency can never reach production uninstalled — the failure mode behind the Node 18 `ERR_REQUIRE_ESM` outage.

After the gate: rsync of tracked files without touching live `.env`, SQLite, or `data/`, a graceful PM2 reload, an `/api/health` verification, and automatic restore of the previous revision on any failure. The hook's source of truth is `deploy/post-receive` in this repository; installing a changed hook is a deliberate server-side copy to `/root/gitstarter.git/hooks/post-receive`.
