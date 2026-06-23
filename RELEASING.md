# Releasing Git Braid

This guide covers everything needed to publish a new version to the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=FWCloud916.git-braid).

---

## Prerequisites (one-time setup)

1. **Register the publisher**
   - Go to <https://marketplace.visualstudio.com/manage> and create publisher
     `FWCloud916` (must match `package.json` `"publisher"` field exactly).

2. **Create a `VSCE_PAT` GitHub secret**
   - In Azure DevOps (<https://dev.azure.com>), generate a Personal Access Token
     with scope **Marketplace → Manage** for all accessible organisations.
   - Add it to the GitHub repo → Settings → Secrets → Actions as `VSCE_PAT`.

No other secrets are needed (Open VSX publishing is not currently configured).

---

## Tag convention — stable vs pre-release

The publish pipeline (`.github/workflows/publish.yml`) classifies the tag
automatically:

| Tag shape | Example | Channel |
|---|---|---|
| `vX.Y.Z` (no suffix) | `v0.2.0` | **Stable** |
| `vX.Y.Z-<suffix>` | `v0.2.0-rc.1`, `v0.3.0-beta.2` | **Pre-release** |

The `--pre-release` flag is added to `vsce package` and `vsce publish` only for
suffixed tags. The version number in `package.json` is plain SemVer either way.

### Marketplace versioning convention

The VS Code Marketplace recommends using minor parity to distinguish channels:

- **Even** minor → stable (`0.2.x`, `0.4.x`, …)
- **Odd** minor → pre-release (`0.1.x`, `0.3.x`, …)

⚠️ A version once published as **pre-release cannot be re-published as stable**.
`v0.1.x` versions are permanently pre-release. The **first stable release must be
`v0.2.0`** (or higher even minor).

---

## Release checklist

### 1. Prepare the version

```bash
# Choose the new version, e.g. 0.2.0 (stable) or 0.3.0-rc.1 (pre-release)
VERSION=0.2.0
```

- Update `"version"` in `package.json` to `$VERSION`.
- Update `version` in `Cargo.toml` (workspace `[workspace.package]`) to `$VERSION`.
- Regenerate `Cargo.lock`: `cargo build --workspace` (or `cargo metadata --no-deps`).
- Add a `CHANGELOG.md` entry for `[$VERSION]` with today's date and list changes.
- Add the compare link at the bottom of `CHANGELOG.md`:
  ```markdown
  [$VERSION]: https://github.com/FWcloud916/vscode-git-braid/compare/vPREV...$VERSION
  ```
- Update `[Unreleased]` compare base to `v$VERSION`.

### 2. Commit and push

```bash
git add package.json Cargo.toml Cargo.lock CHANGELOG.md
git commit -m "chore: bump version → $VERSION"
git push origin main
```

### 3. Tag and push

```bash
# Stable release (even minor, no suffix):
git tag v$VERSION && git push origin v$VERSION

# Pre-release (odd minor or suffix):
git tag v$VERSION-rc.1 && git push origin v$VERSION-rc.1
```

Pushing a `v*` tag **automatically triggers the full pipeline**:
build-napi (4 platforms) → package 4 `.vsix` → single `vsce publish`.

### 4. Verify

- Monitor the Actions run: **Actions → Publish to VS Code Marketplace**.
  - The `prepare` job log should print either `→ stable release` or `→ pre-release`.
  - All three phases (`prepare`, `build-napi`, `package`, `publish`) must be green.
- Check the Marketplace listing: <https://marketplace.visualstudio.com/items?itemName=FWCloud916.git-braid>
  - Stable tags: new version visible to all users, no pre-release badge.
  - Pre-release tags: version visible only to users who opted into pre-releases.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `vsce publish` fails with 401 | `VSCE_PAT` missing or expired | Regenerate PAT; update repo secret |
| "Extension already exists" | Version already published (any channel) | Bump version |
| "Version already published as pre-release" | Trying to publish same version as stable | Bump to a new even-minor version |
| `prepare` job classifies wrong | Tag pushed has unexpected suffix | Delete + re-push correct tag: `git tag -d vX.Y.Z && git push origin :vX.Y.Z` |
