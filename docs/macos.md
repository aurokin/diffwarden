# macOS Operations

Diffwarden is a Node CLI that launches reviewer SDKs and external reviewer CLIs. Signing or
notarizing Diffwarden's JavaScript entry point is not the useful trust boundary; macOS mostly
evaluates the `node` runtime, native dependencies, and the reviewer executables Diffwarden
starts.

## Executable Trust Checks

Inspect a reviewer executable with:

```bash
diffwarden macos doctor --executable claude
diffwarden macos doctor --path /Users/auro/.local/bin/droid
diffwarden macos doctor --executable codex --json
```

The command checks:

- `com.apple.quarantine` with `xattr`
- code signature verification with `codesign`
- Gatekeeper execution assessment with `spctl`

The command is diagnostic only. It does not remove attributes or modify system policy.

## Manual Checks

Use these commands when diagnosing a specific reviewer CLI:

```bash
which droid
xattr -l "$(which droid)"
codesign --verify --deep --strict "$(which droid)"
spctl --assess --type execute "$(which droid)"
```

If `com.apple.quarantine` is set on an executable you trust and installed intentionally, remove
only that attribute:

```bash
xattr -d com.apple.quarantine "$(which droid)"
```

Do not recursively remove extended attributes from broad directories unless you understand what
else is stored there.

## Stable Executable Paths

Prefer stable installed reviewer executables in `cliOptions.executable`. Avoid pointing
Diffwarden at generated temp scripts, changing build outputs, or downloaded binaries that still
carry quarantine metadata.

Good:

```json
{
  "cliOptions": {
    "executable": "/Users/auro/.local/bin/claude"
  }
}
```

Riskier:

```json
{
  "cliOptions": {
    "executable": "/var/folders/.../generated-reviewer-wrapper"
  }
}
```

Diffwarden's own CLI transport writes temp files for prompt, schema, config, and output data. It
does not generate executable temp wrappers in production paths.

## Spotlight And Reports

Review reports are opt-in, but repo-local reports can create high-churn files under
`.diffwarden/reports/`. If Spotlight indexing is noisy on a large repo, prefer a custom report
directory that is already excluded from indexing or add the directory to Spotlight Privacy in
System Settings.

For a quick audit:

```bash
mdfind -onlyin .diffwarden/reports 'kMDItemFSName == "*"'
```

Avoid disabling Spotlight indexing for a whole volume from Diffwarden automation. That is a
system-wide decision and broader than this tool should make.

## Performance Triage

When a run causes machine-wide slowdown, first identify whether the spike is tied to one reviewer
or to a multi-reviewer burst:

```bash
diffwarden --target base:main --reviewer claude
diffwarden --target base:main --reviewer droid-cli
diffwarden --target base:main --reviewer-set 2
```

Then inspect the involved executables:

```bash
diffwarden macos doctor --executable claude --executable droid --executable codex
```
