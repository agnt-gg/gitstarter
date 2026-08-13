# Push-to-deploy

GitStarter uses the same deployment shape as `agnt-server`: one named remote with two push URLs.

```bat
set "GIT_SSH_COMMAND=ssh -i C:/Users/Studio/.ssh/agnt_do -o IdentitiesOnly=yes -o BatchMode=yes"
git push production main
```

`production` pushes sequentially to:

1. `root@agnt.gg:/root/gitstarter.git` — server-side deploy hook.
2. `https://github.com/agnt-gg/gitstarter.git` — public source mirror.

The server hook stages the exact pushed tree, runs `npm test` and `npm run build:client`, syntax-checks the server, rsyncs tracked files without deleting live `.env`, SQLite, or `node_modules`, gracefully reloads `gitstarter-api`, verifies PM2 and `/api/health`, and restores the previous revision on failure.

The hook never runs `git clean` or `npm ci`. Dependency changes require a deliberate server-side `npm install` before deployment.
