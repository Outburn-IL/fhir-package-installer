---
name: fpi-cli
description: Use whenever the user wants to install, download, inspect, or check FHIR packages from the command line via the `fpi` CLI (FHIR Package Installer). Covers commands like `install`, `download`, `install-local`, `get-manifest`, `get-index`, `get-dependencies`, `to-package-object`, `check-latest`, `is-installed`, `get-cache`, and `get-package-path`. Trigger even when the user just says things like "install the r4 core package", "download a FHIR package tarball", "check what version of hl7.fhir.uv.sdc is on the registry", "is this package cached", "show me the package manifest", or otherwise references FHIR packages, the FHIR package cache (`~/.fhir/packages`), or the `packages.fhir.org` registry.
---

# fpi — FHIR Package Installer CLI

`fpi` is a CLI for downloading, installing, inspecting, and managing FHIR conformance packages from a FHIR package registry (default: `https://packages.fhir.org`). It maintains a local cache laid out per the FHIR Package Cache spec (`~/.fhir/packages` on user installs, `%ProgramData%\.fhir\packages` for system services).

Assume `fpi` is on PATH. If it isn't, the user needs to install/build it — don't silently switch to `node dist/cli.mjs`.

## Package identifier syntax

Almost every command takes a `<packageId>`. Accepted forms:

- `name` — resolves to the latest version via the registry
- `name@version` — explicit version (preferred form to show users)
- `name#version` — also accepted (matches the on-disk folder naming)

Cached package folders are named `name#version` (e.g. `hl7.fhir.r4.core#4.0.1`), not with `@`. When you read paths from the cache, expect `#`. When you write commands for users, prefer `@`.

## Global options (must come before the subcommand)

| Flag | Meaning |
|---|---|
| `-r, --registry-url <url>` | Override registry URL. Pass `n/a` to disable all network access (offline mode). |
| `-t, --registry-token <token>` | Bearer token for a private registry. |
| `-c, --cache-path <path>` | Use a custom cache directory instead of the FHIR-spec default. |
| `-s, --skip-examples` | Do not recurse into example packages when installing dependencies. |
| `--allow-http` | Permit non-HTTPS registry URLs (testing only). |
| `--request-timeout <ms>` | HTTP timeout (positive integer). |
| `--extract-timeout <ms>` | Tarball extraction timeout (positive integer). |
| `--registry-ttl <ms>` | TTL for cached registry metadata. |
| `-v, --verbose` | Enable debug logging (very chatty during installs — useful for diagnosing hangs). |
| `-V, --version` | Print CLI version. |
| `-h, --help` | Help; works per command too (e.g. `fpi install --help`). |

Order matters: global options bind to `program`, so they must precede the subcommand. `fpi install -c /tmp/x hl7.fhir.r4.core` will NOT pick up `-c`; use `fpi -c /tmp/x install hl7.fhir.r4.core`.

`--request-timeout`, `--extract-timeout`, and `--registry-ttl` reject non-integers with a hard error from `parseIntOption` — don't pass `"30s"` or similar.

## Commands

Aliases shown in parentheses.

### `install <packageId>` (`i`)
Download a package and recursively install its dependencies, including implicit FHIR core deps (e.g. installing `hl7.fhir.r4.core@4.0.1` also pulls `hl7.terminology.r4` and `hl7.fhir.uv.extensions.r4`). Idempotent — re-running on a fully cached package is a no-op.

### `download <packageId>` (`dl`)
Download just the `.tgz` (no dependency resolution, no cache install). Options:
- `-d, --dest <dir>` — destination directory (defaults to current location)
- `-o, --overwrite` — overwrite existing file
- `-e, --extract` — extract the tarball after downloading (produces a `name#version/` folder next to the `.tgz`)

### `install-local <src>` (`il`)
Install from a local `.tgz` file or an already-extracted package directory. Options:
- `-i, --id <packageId>` — override the identifier (defaults to whatever the package's own `package.json` says)
- `-o, --override` — overwrite existing cached copy
- `-d, --install-dependencies` — also resolve and install the package's declared dependencies

Useful when working with a package that isn't on a public registry, or for republishing under a custom id.

### `get-manifest <packageId>` (`gm`)
Print the package's `package.json` as JSON. Requires the package to be installed (won't fetch it for you).

### `get-index <packageId>` (`gi`)
Print the `.fpi.index.json` (fpi's resource index, schema-version 2). If the file is missing, fpi generates it. This file is **large** for core packages (tens of thousands of lines for r4.core) — when you call this command on behalf of the user, expect to truncate or pipe to a file.

### `get-dependencies <packageId>` (`gd`)
Print the package's effective dependency map (explicit deps from `package.json` plus implicit FHIR-core deps). Options:
- `--root <rootPackageId>` — root package for graph-aware implicit version selection
- `--planning-fallbacks` — include planning fallbacks for unresolved implicit deps

Most callers just want `fpi gd <packageId>`; the flags are for tooling that's building a dependency plan across a graph.

### `to-package-object <packageId>` (`tpo`)
Parse `name`, `name@version`, or `name#version` into `{ "id", "version" }`. If no version is given, resolves to latest via the registry (requires network).

### `check-latest <packageName>` (`cl`)
Resolve the latest published version of `<packageName>` from the registry. Prints just the version string. Fails (exit 1) when the registry is disabled (`-r n/a`).

### `is-installed <packageId>` (`is`)
Determine whether a package is in the local cache. Options:
- `--shallow` — only check the package itself; skip dependency validation
- `--raw` — print just `true` / `false` instead of a friendly sentence

Default output is human-friendly ("Package X is already installed."). When you need to branch on the result in a script, pass `--raw`. This command suppresses logging by design, so it's safe to capture stdout.

### `get-cache` (`gc`)
Print the resolved cache directory (after applying `-c` / env / defaults).

### `get-package-path <packageId>` (`gp`)
Print the absolute path to a specific package folder in the cache (the `name#version` directory).

## Common workflows

**Install a pinned package + deps into a custom cache:**
```
fpi -c /path/to/cache install hl7.fhir.r4.core@4.0.1
```

**Check what's on the registry without installing:**
```
fpi check-latest hl7.fhir.uv.sdc
fpi tpo hl7.fhir.uv.sdc          # also resolves "latest" into {id, version}
```

**Script-friendly cache check:**
```
fpi -c /path/to/cache is hl7.fhir.r4.core@4.0.1 --raw
```

**Inspect an installed package:**
```
fpi -c /path/to/cache get-manifest hl7.fhir.r4.core@4.0.1
fpi -c /path/to/cache get-package-path hl7.fhir.r4.core@4.0.1
fpi -c /path/to/cache get-dependencies hl7.fhir.r4.core@4.0.1
```

**Download + extract a tarball without caching it:**
```
fpi download hl7.fhir.uv.sdc@3.0.0 -d ./downloads -e
```

**Reinstall from a local tarball with a custom id:**
```
fpi -c /path/to/cache install-local ./pkg.tgz -i my.local.copy@1.0.0 -o
```

**Offline use (registry disabled):**
```
fpi -c /path/to/cache -r n/a is-installed hl7.fhir.r4.core@4.0.1
fpi -c /path/to/cache -r n/a install hl7.fhir.r4.core@4.0.1   # works only if everything is already cached
```
In offline mode, `check-latest` fails, and implicit dep version selection falls back to the newest version already in the cache — fpi will warn on stderr.

**Diagnose a slow install:**
```
fpi -c /path/to/cache -v install <packageId>
```
`-v` emits `[timing]`, `[extract]`, `[publish]` lines and lock claim/release events — invaluable for figuring out where it's stuck.

## Behavioral notes worth knowing

- **Exit codes:** any unhandled error (network failure, missing package, bad input) is caught by a process-wide proxy and exits `1` with `Error in <method>: <message>` on stderr. Validation errors from `parseIntOption` exit with an uncaught stack trace (not wrapped).
- **`is-installed` is silent.** It deliberately disables the logger so its stdout is safe to capture. Other commands print progress to stdout and may also write to stderr.
- **Implicit deps** (per FHIR tooling convention): installing `hl7.fhir.r{3,4,5}.core` pulls a matching `hl7.terminology.r*` and `hl7.fhir.uv.extensions.r*`. Use `get-dependencies` to see the effective list.
- **Cache layout:** packages live at `<cache>/<id>#<version>/package/...`. fpi-internal state (locks, staging, tarball cache, generated indexes) lives under `<cache>/.fpi.cache/`. Treat `.fpi.cache/` as opaque.
- **`get-index` output is huge.** For `hl7.fhir.r4.core@4.0.1` it's ~45k lines. When running it programmatically, redirect to a file or pipe through a filter; don't dump it into a chat.
- **Aliases are first-class.** All examples above using long names work equally with their short alias (`i`, `dl`, `il`, `gm`, `gi`, `gd`, `tpo`, `cl`, `is`, `gc`, `gp`).
- **`--registry-url n/a`** is the supported way to assert "no network", not omitting the flag. Without it, fpi uses `https://packages.fhir.org` by default.

## When NOT to reach for fpi

- If the user wants to author/edit FHIR resources (StructureDefinitions, ValueSets) — that's an IG-publisher / sushi territory.
- If they want to publish a package to a registry — fpi only consumes packages.
- If they need npm-style semver range resolution — fpi resolves to single concrete versions, not ranges.
