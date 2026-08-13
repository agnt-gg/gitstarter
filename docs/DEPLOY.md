# Push-to-deploy

GitStarter uses the same deployment shape as `agnt-server`: one named remote with two push URLs.

```bat
set "GIT_SSH_COMMAND=ssh -i C:/Users/Studio/.ssh/agnt_do -o IdentitiesOnly=yes -o BatchMode=yes"
git push production main
```

`production` pushes sequentially to:

1. `root@agnt.gg:/root/gitstarter.git` — server-side deploy hook.
2. `https://github.com/agnt-gg/gitstarter.git` — public source mirror.

The server hook stages the exact pushed tree, runs `npm test`, syntax-checks both the server and committed browser bundle, verifies the public entrypoint exists, rsyncs tracked files without deleting live `.env`, SQLite, or `node_modules`, gracefully reloads `gitstarter-api`, verifies PM2 and `/api/health`, and restores the previous revision on failure. Browser assets must be built and committed before pushing; production deliberately does not install build-only dependencies.

The hook never runs `git clean` or `npm ci`. Dependency changes require a deliberate server-side `npm install` before deployment.
