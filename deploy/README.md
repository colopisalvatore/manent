# Deploy: a git-backed brain

The vault is a git repository, so deploying it is a push. Nothing in this directory is required to
run Manent — `manent serve <vault>` is enough — but this is the layout that has been running, and
the reasoning behind each part of it.

```
/srv/brain                  the vault: the working tree the server reads and watches
/srv/brain.git              the bare repository people and CI push to
/opt/manent                 the code: a checkout of this repository, built
/etc/manent/manent.env      MANENT_HTTP_TOKEN, 0600, owned by the service user
/etc/manent/agents.json     agent identities and their tokens, 0600
/var/lib/manent/            gaps.sqlite and audit.jsonl — state, not vault
```

The split that matters is the last one. The vault is restorable from any clone; the gap register
and the audit log are not, because they record what was asked and by whom, which happened once.
**Back up `/var/lib/manent` separately from the vault**, and remember that it is the only part of
the deployment holding questions.

## The server

```
useradd --system --home /srv --shell /usr/sbin/nologin manent
install -d -o manent -g manent /srv/brain /var/lib/manent /etc/manent

git clone https://github.com/colopisalvatore/manent /opt/manent
cd /opt/manent && npm ci && npm run build

printf 'MANENT_HTTP_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/manent/manent.env
cp deploy/agents.example.json /etc/manent/agents.json   # then replace every token
chmod 600 /etc/manent/manent.env /etc/manent/agents.json
chown manent:manent /etc/manent/manent.env /etc/manent/agents.json

cp deploy/manent-brain.service /etc/systemd/system/
systemctl enable --now manent-brain
```

`agents.json` maps a name to `{token, read, write}`: the audience labels that identity may see, and
the one directory it may write into. Generate one token per agent (`openssl rand -hex 32`), never
share one between two, and expect the server to refuse to start rather than guess — a short token,
a misspelt label or a duplicate is fatal at startup, because the alternative is an agent quietly
seeing more or less than intended.

Bind to `127.0.0.1` and put a TLS terminator or a tunnel in front. A bearer token over plaintext
is a token published.

## The push

```
git init --bare /srv/brain.git
cp deploy/hooks/pre-receive deploy/hooks/post-receive /srv/brain.git/hooks/
chmod +x /srv/brain.git/hooks/pre-receive /srv/brain.git/hooks/post-receive
chown -R manent:manent /srv/brain.git
```

Both hooks read their configuration from the environment: `MANENT_VAULT` (default `/srv/brain`),
`MANENT_BRANCH` (`main`), `MANENT_BIN` (`manent`, or the path to `packages/cli/dist/index.js` run
by node), `MANENT_AUDIENCES` (the labels the vault allows, comma separated).

- **`pre-receive` is the gate.** It extracts the pushed tree to a temporary directory and runs
  `manent lint --strict-content` on it. Personal data or text that reads as an instruction to a
  model is refused at the push. A vault lives in git and git history is forever: the only cheap
  moment to catch that is before it is accepted.
- **`post-receive` checks the tree out** into the vault directory and cleans what the push deleted.
  It does not restart anything. `manent serve` watches the vault and re-indexes what changed — a
  new note is searchable about half a second later — and a restart would throw away the dense
  index and every warm per-identity view for no gain.

Then, from a laptop:

```
git remote add brain manent@server:/srv/brain.git
git push brain main
```

## Updating the code

The vault syncs itself; the code does not, and confusing the two is how a server ends up serving a
version nobody has locally:

```
cd /opt/manent && git fetch && git reset --hard origin/main
npm ci && npm run build
systemctl restart manent-brain
```

That restart is the one that is fine: it costs a warmup, not data. Watch it come back with
`journalctl -u manent-brain -f` — the port opens before the model is loaded, and answers lexically
until it is warm.
