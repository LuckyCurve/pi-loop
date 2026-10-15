# Publishing

Publishing happens in two places at once, because they are the same action:

- **npm** — `npm publish` makes the package installable with `pi install npm:@luckycurve/pi-loop`.
- **The pi package gallery** — [pi.dev/packages](https://pi.dev/packages) is an *index of npm
  packages*, not a separate registry. It discovers any public npm package whose metadata carries the
  `pi-package` keyword. There is no upload form and no review step.

So the only requirement is that the published package keeps the `pi-package` keyword in
`keywords`. Removing that keyword silently drops the package from the gallery.

## Preflight

```bash
npm run typecheck                 # must be clean
npm test                          # must be green
npm pack --dry-run                # confirm what ships
```

The `prepublishOnly` script runs typecheck and tests, so `npm publish` cannot ship an untested
tarball by accident.

What ships is limited by `files` in `package.json`: `extensions/`, `src/`, the two READMEs, and
AGENTS.md. Tests and CI config stay out of the tarball.

## Check the name

`@luckycurve/pi-loop` is the published name. The unscoped `pi-loop` is taken on npm by an unrelated
package, which is why the scope is used. Before publishing a new name:

```bash
npm view <name> version --registry=https://registry.npmjs.org
```

An `E404` means the name is free.

## Recommended: trusted publishing from CI

`.github/workflows/release.yml` publishes on a `v*` tag. It uses npm **trusted publishing** (OIDC),
which needs no long-lived secret:

1. On npm, open the package's settings → *Trusted publishing* → add a GitHub Actions publisher:
   - Organization/user: `LuckyCurve`
   - Repository: `pi-loop`
   - Workflow filename: `release.yml`
   - Environment: *(leave empty unless the workflow declares one)*
2. Cut a release:
   ```bash
   npm version patch          # or minor / major; commits and tags
   git push --follow-tags
   ```

The workflow also passes `--provenance`, which attaches a signed statement linking the tarball to
the commit and workflow that produced it.

Without trusted publishing configured, the workflow falls back to a `NPM_TOKEN` repository secret.
Add it under *Settings → Secrets and variables → Actions*. Use a **granular access token** with
read/write permission for this package only, not a classic token.

## Alternative: publish locally

```bash
npm login --registry=https://registry.npmjs.org
npm publish --access public
```

The local npm config points `registry` at a mirror, so pass `--registry` explicitly to publish to
the real registry. Publishing to a mirror will not reach the gallery.

## Verify after publishing

```bash
npm view @luckycurve/pi-loop version --registry=https://registry.npmjs.org
npm view @luckycurve/pi-loop keywords --registry=https://registry.npmjs.org   # must include pi-package
```

Then confirm pi can install and load it from the registry:

```bash
cd /tmp && pi install npm:@luckycurve/pi-loop
pi --print "reply OK"        # loads with no extension error
```

Loading is the real test: a package with a bad manifest or a `dependencies` entry for a
host-provided package still installs cleanly and only fails when pi loads it. Pi warns when
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-tui`, or `typebox` appear in `dependencies` instead of `peerDependencies`; all
of them do here, so that warning must stay absent.

## Version notes

`0.x` releases are for development. `pi update --extensions` moves installed packages forward, so
keep version numbers meaningful: a behaviour change that alters how a running loop behaves is a
minor bump, a fix is a patch.

## Gallery preview (optional)

An optional `pi.image` pointing at a screenshot adds a gallery thumbnail:

```jsonc
{
  "pi": {
    "extensions": ["./extensions/loop/index.ts"],
    "image": "https://raw.githubusercontent.com/LuckyCurve/pi-loop/main/assets/preview.png"
  }
}
```

Use an absolute URL: the gallery does not resolve repo-relative paths. MP4 is supported via
`pi.video`.
