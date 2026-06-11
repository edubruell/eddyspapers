# Maintenance page

A single self-contained static page shown on any of the three sites
(`econpapers`, `agenticsearch`, `econpeople`) while the service is being updated.

Files (drop-in, no build step, no external requests):

- `index.html` — the page (cream `#efe9de`, midpoint of the two brand tones)
- `maintanence.webp` — the Maintenance Meerkat
- `favicon.svg`

## Deploy the folder

Put it somewhere nginx can read, e.g.:

```sh
rsync -av maintenance/ root@econpapers.eduard-bruell.de:/srv/maintenance/
```

## Toggle maintenance mode (nginx, flag-file driven)

Add to each `server { }` block you want to be able to gate. `return`/`rewrite`
inside `if` are the safe uses of `if` in nginx.

```nginx
# Flip on:  touch /srv/maintenance/.on
# Flip off: rm    /srv/maintenance/.on
if (-f /srv/maintenance/.on) {
    return 503;
}
error_page 503 @maintenance;
location @maintenance {
    root /srv/maintenance;
    rewrite ^.*$ /index.html break;
}
```

Then:

```sh
touch /srv/maintenance/.on   # maintenance ON  (503 + page, for every site sharing the flag)
nginx -t && systemctl reload nginx   # only needed after editing the config, not for the flag
rm /srv/maintenance/.on       # maintenance OFF
```

The 503 status keeps search engines from indexing the placeholder and tells
clients/monitors the outage is intentional and temporary.

To gate the three sites independently, use a per-site flag
(e.g. `.on-agentic`) and reference it in that site's block only.
