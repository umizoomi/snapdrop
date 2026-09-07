# Deploying Snapdrop to CloudPanel

Zero-downtime deployment via CloudPanel's [dploy](https://www.cloudpanel.io/docs/v2/dploy/introduction/)
tool, triggered from GitHub Actions on every push to `master`.

## Architecture

- `client/` is served as static files by nginx.
- `server/` (the WebSocket relay) runs as a single Node.js process under
  [PM2](https://pm2.keymetrics.io/), managed by `ecosystem.config.js` at the
  repo root.
- nginx proxies only `/server*` requests (WebSocket) to the Node process; the
  rest is static.
- `dploy` runs **on the CloudPanel server** and pulls code by cloning the
  GitHub repo directly (pull-based). GitHub Actions only SSHes in and tells
  `dploy` which ref to deploy - it never pushes files itself.
- Every deploy creates a new timestamped release directory and atomically
  flips a `current` symlink to it, so a bad deploy never takes the site down:
  if `npm ci` fails, the deploy aborts before the symlink moves and the old
  release keeps serving traffic.

This app is stateless (no database, no uploads), so there is nothing to keep
in `shared_directories` and no migrations to run.

---

## Part 1 - CloudPanel host admin

Do these once per server/site.

### 1.1 Install dploy (as root)

Follow <https://www.cloudpanel.io/docs/v2/dploy/installation/>:

```bash
curl -sS https://dploy.cloudpanel.io/dploy -o /usr/local/bin/dploy
chmod +x /usr/local/bin/dploy
```

### 1.2 Create the site

In CloudPanel: **Sites -> Add Site -> Create a Node.js Site**.

- Domain: your domain (e.g. `snapdrop.example.com`)
- Node.js Version: 18 or newer (matches `server/`'s dependencies)
- App Port: `3000` (must match `ecosystem.config.js`'s `PORT` and the port
  used in `deploy/cloudpanel/vhost.conf.example`)

Note the generated **Site User** - all further steps run as that user.

### 1.3 Install Node.js and PM2 for the site user

```bash
ssh SITE_USER@your-server
nvm install 18           # or whatever version you picked above
nvm alias default 18     # required so `nvm use default` resolves in CI
npm install pm2@latest -g
```

### 1.4 Give the site user a GitHub deploy key

```bash
ssh SITE_USER@your-server
mkdir -p ~/.ssh && cd ~/.ssh
ssh-keygen -f dploy-git    # no passphrase
cat dploy-git.pub
```

Add the printed public key as a **read-only Deploy Key** on the
`umizoomi/snapdrop` GitHub repo: Settings -> Deploy keys -> Add deploy key.

Then, still as the site user:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  User git
  IdentityFile ~/.ssh/dploy-git
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com   # confirm it authenticates
```

### 1.5 Initialize dploy

```bash
ssh SITE_USER@your-server
dploy init generic
```

When prompted:
- Git Repository: `git@github.com:umizoomi/snapdrop.git`
- Deploy Directory: `/home/SITE_USER/htdocs/your-domain`

This creates `~/.dploy/config.yml` and the `releases/` / `shared/` /
`current` directory structure under the deploy directory.

### 1.6 Replace config.yml

Copy [`cloudpanel/config.yml.example`](cloudpanel/config.yml.example) over
`~/.dploy/config.yml`, replacing `SITE_USER` and `SITE_DOMAIN` with your real
values in **both** the `directory:` line and the `after_commands`.

```bash
nano ~/.dploy/config.yml
```

### 1.7 Set the site's Root Directory

CloudPanel: **Site -> Settings -> Domain Settings -> Root Directory** ->
`current/client`

This makes nginx's document root track `dploy`'s `current` release symlink,
pointed at the static client files inside it.

### 1.8 Update the vhost

CloudPanel: **Site -> Vhost**. Follow the instructions at the top of
[`cloudpanel/vhost.conf.example`](cloudpanel/vhost.conf.example) - replace
the default Node.js `location /` proxy block with the `/server` proxy block
and static `location /` block from that file. Save.

### 1.9 First deploy (manual, to verify)

```bash
ssh SITE_USER@your-server
dploy deploy master
pm2 status        # snapdrop-server should be "online"
pm2 logs snapdrop-server --lines 50
```

Visit your domain - the Snapdrop UI should load and pair with itself in two
browser tabs on the same network.

### 1.10 Keep PM2 alive across reboots

```bash
echo $PATH   # copy the output
crontab -e
```

Add:

```
PATH=<paste the output of echo $PATH here>
@reboot pm2 resurrect &> /dev/null
```

Then `pm2 save` again so `pm2 resurrect` has something to restore.

---

## Part 2 - GitHub admin

### 2.1 Generate a CI deploy keypair

On your own machine (not the server):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ./cloudpanel_ci_deploy -N ""
```

Add the **public** key (`cloudpanel_ci_deploy.pub`) to the site user via
CloudPanel: **Site -> Settings -> Site User Settings -> SSH Keys**.

### 2.2 Add repo secrets

`umizoomi/snapdrop` -> Settings -> Secrets and variables -> Actions:

| Secret | Value |
|---|---|
| `CLOUDPANEL_SSH_HOST` | server IP or hostname |
| `CLOUDPANEL_SSH_PORT` | SSH port (omit to default to 22) |
| `CLOUDPANEL_SSH_USER` | the CloudPanel site user |
| `CLOUDPANEL_SSH_KEY` | the **private** key from 2.1, full contents |

Delete the local private key file once it's in GitHub, or store it in a
password manager - don't leave it on disk.

### 2.3 Workflows already in this repo

- **`.github/workflows/deploy.yml`** - on every push to `master`, SSHes into
  CloudPanel and runs `dploy deploy <ref>`. Also runnable manually
  (Actions -> Deploy to CloudPanel -> Run workflow) against any branch or
  tag.
- **`.github/workflows/sync-upstream.yml`** - runs monthly (1st of the
  month), checks
  `RobinLinus/snapdrop:master` for new commits. If there are any, it force-
  pushes them onto a `sync/upstream` branch and opens (or refreshes) a PR
  into `master`. It never pushes to `master` directly, so upstream changes
  always get a human review before they can reach production. Merging that
  PR triggers `deploy.yml`.

Nothing else to configure for these - they use the built-in
`GITHUB_TOKEN`, no extra secrets needed.

`deploy.yml` explicitly sources `~/.nvm/nvm.sh` and runs `nvm use default`
before calling `dploy` - a bare login shell (`bash -lc`) isn't enough,
because nvm's init lives in `~/.bashrc`, which non-interactive SSH commands
never source even with `-l`. If `npm`/`pm2` still aren't found in the
workflow logs, re-check that `nvm alias default` was set (step 1.3).

### 2.4 Rolling back

`dploy` keeps the 3 most recent releases on the server. To roll back without
a new deploy:

```bash
ssh SITE_USER@your-server
ls ~/htdocs/your-domain/releases     # find the previous release
ln -sfn ~/htdocs/your-domain/releases/<previous> ~/htdocs/your-domain/current
pm2 restart snapdrop-server
```

For a tracked rollback instead, deploy a git tag (`dploy deploy v1.2.3` /
dispatch the workflow with that tag as `ref`) rather than `master`.
