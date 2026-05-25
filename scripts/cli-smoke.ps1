$ErrorActionPreference = 'Continue'

$repoRoot   = (Resolve-Path "$PSScriptRoot\..").Path
$outFile    = Join-Path $repoRoot 'cli-test-results.md'
$cliPath    = Join-Path $repoRoot 'dist\cli.mjs'
$cachePath  = Join-Path $env:TEMP 'fpi-cli-test'
$downloadPath = Join-Path $env:TEMP 'fpi-cli-dl'

Remove-Item -Recurse -Force $cachePath -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $downloadPath -ErrorAction SilentlyContinue
New-Item -ItemType Directory $downloadPath | Out-Null

"# FPI CLI smoke test results" | Set-Content -Path $outFile -Encoding utf8
"" | Add-Content -Path $outFile
"Generated: $(Get-Date -Format o)"            | Add-Content -Path $outFile
"Cache path: ``$cachePath``"                  | Add-Content -Path $outFile
"Download path: ``$downloadPath``"            | Add-Content -Path $outFile
"" | Add-Content -Path $outFile

function Invoke-Fpi {
    param(
        [string]$Section,
        [string]$Description,
        [string[]]$FpiArgs,
        [int]$TruncateLines = 0
    )

    $displayCmd = "fpi " + ($FpiArgs -join ' ')
    "## $Section"                  | Add-Content -Path $outFile
    if ($Description) {
        $Description               | Add-Content -Path $outFile
    }
    ""                             | Add-Content -Path $outFile
    "Command:"                     | Add-Content -Path $outFile
    '```'                          | Add-Content -Path $outFile
    $displayCmd                    | Add-Content -Path $outFile
    '```'                          | Add-Content -Path $outFile
    ""                             | Add-Content -Path $outFile

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'node' `
        -ArgumentList (@($cliPath) + $FpiArgs) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError  $stderrFile
    $exit = $proc.ExitCode
    $stdout = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue
    Remove-Item $stdoutFile, $stderrFile -ErrorAction SilentlyContinue

    if ($TruncateLines -gt 0) {
        if ($stdout) {
            $lines = $stdout -split "`r?`n"
            if ($lines.Count -gt $TruncateLines) {
                $stdout = (($lines | Select-Object -First $TruncateLines) -join "`n") + "`n... [truncated $($lines.Count - $TruncateLines) more lines]"
            }
        }
    }

    "Exit code: ``$exit``" | Add-Content -Path $outFile
    ""                     | Add-Content -Path $outFile
    if ($stdout) {
        "stdout:"          | Add-Content -Path $outFile
        '```'              | Add-Content -Path $outFile
        $stdout.TrimEnd()  | Add-Content -Path $outFile
        '```'              | Add-Content -Path $outFile
        ""                 | Add-Content -Path $outFile
    }
    if ($stderr) {
        "stderr:"          | Add-Content -Path $outFile
        '```'              | Add-Content -Path $outFile
        $stderr.TrimEnd()  | Add-Content -Path $outFile
        '```'              | Add-Content -Path $outFile
        ""                 | Add-Content -Path $outFile
    }
    "---" | Add-Content -Path $outFile
    ""    | Add-Content -Path $outFile

    Write-Host ("[exit=$exit] " + $displayCmd)
}

# ---- Basics ----
Invoke-Fpi 'Version flag'   'Prints the build-injected version.'                                @('--version')
Invoke-Fpi 'Top-level help' 'Shows ASCII banner + global options + commands.'                    @('--help') -TruncateLines 80
Invoke-Fpi 'Per-command help' 'Help for `install` shows aliases and command-specific options.'   @('install', '--help')

# ---- Read-only / resolution ----
Invoke-Fpi 'get-cache'      'Print the resolved cache directory.'                                @('-c', $cachePath, 'get-cache')
Invoke-Fpi 'to-package-object (pinned)' 'Parses an explicit name@version into {id,version}.'    @('-c', $cachePath, 'to-package-object', 'hl7.fhir.r4.core@4.0.1')
Invoke-Fpi 'tpo alias (latest)' 'Alias of to-package-object; resolves "latest" via registry.'   @('-c', $cachePath, 'tpo', 'hl7.fhir.r4.core')
Invoke-Fpi 'check-latest'   'Resolves latest published version from the registry.'              @('-c', $cachePath, 'check-latest', 'hl7.fhir.r4.core')
Invoke-Fpi 'cl alias'       'Alias for check-latest.'                                            @('-c', $cachePath, 'cl', 'hl7.fhir.uv.sdc')

# ---- Install + dependents ----
Invoke-Fpi 'install (verbose)' 'Installs r4.core@4.0.1 with debug logging enabled.'              @('-c', $cachePath, '-v', 'install', 'hl7.fhir.r4.core@4.0.1') -TruncateLines 60
Invoke-Fpi 'is-installed (deep)' 'Deep check including dependencies.'                            @('-c', $cachePath, 'is-installed', 'hl7.fhir.r4.core@4.0.1')
Invoke-Fpi 'is-installed --shallow' 'Shallow check, skips dependency validation.'                @('-c', $cachePath, 'is', 'hl7.fhir.r4.core@4.0.1', '--shallow')
Invoke-Fpi 'is-installed --raw (installed)' 'Prints raw boolean instead of a friendly message.' @('-c', $cachePath, 'is', 'hl7.fhir.r4.core@4.0.1', '--raw')
Invoke-Fpi 'is-installed --raw (not installed)' 'Raw boolean output for a missing package.'    @('-c', $cachePath, 'is', 'does.not.exist@9.9.9', '--raw')
Invoke-Fpi 'get-manifest'   'Print the package.json manifest (truncated).'                       @('-c', $cachePath, 'get-manifest', 'hl7.fhir.r4.core@4.0.1') -TruncateLines 25
Invoke-Fpi 'get-index'      'Print the .fpi.index.json content (truncated).'                     @('-c', $cachePath, 'get-index', 'hl7.fhir.r4.core@4.0.1') -TruncateLines 20
Invoke-Fpi 'get-dependencies' 'Explicit + implicit dependencies.'                                @('-c', $cachePath, 'get-dependencies', 'hl7.fhir.r4.core@4.0.1')
Invoke-Fpi 'get-dependencies --root --planning-fallbacks' 'Graph-aware resolution flags.'        @('-c', $cachePath, 'gd', 'hl7.fhir.r4.core@4.0.1', '--root', 'hl7.fhir.r4.core@4.0.1', '--planning-fallbacks')
Invoke-Fpi 'get-package-path' 'Print path to a specific cached package.'                         @('-c', $cachePath, 'get-package-path', 'hl7.fhir.r4.core@4.0.1')

# ---- Download (no-extract, then extract+overwrite) ----
Invoke-Fpi 'download (tarball)' 'Downloads the .tgz to a destination directory.'                 @('-c', $cachePath, 'download', 'hl7.fhir.uv.sdc@3.0.0', '-d', $downloadPath)
Invoke-Fpi 'dl -o -e (overwrite + extract)' 'Downloads again with overwrite, then extracts.'    @('-c', $cachePath, 'dl', 'hl7.fhir.uv.sdc@3.0.0', '-d', $downloadPath, '-o', '-e')

# ---- install-local ----
$localTarball = Join-Path $downloadPath 'hl7.fhir.uv.sdc-3.0.0.tgz'
$localExtracted = Join-Path $downloadPath 'hl7.fhir.uv.sdc#3.0.0'
Invoke-Fpi 'install-local (tarball, custom id, override)' 'Installs from local .tgz with a custom id.' @('-c', $cachePath, 'install-local', $localTarball, '-i', 'my.local.copy@1.0.0', '-o')
Invoke-Fpi 'il (directory, install deps)' 'Installs from an extracted directory and resolves deps.' @('-c', $cachePath, 'il', $localExtracted, '-d') -TruncateLines 60

# ---- Global tuning flags ----
Invoke-Fpi 'tuning flags + skip-examples' 'Passes through timeouts, TTL, and -s.'                @('-c', $cachePath, '--request-timeout', '60000', '--extract-timeout', '60000', '--registry-ttl', '60000', '-s', 'install', 'hl7.fhir.uv.sdc@3.0.0')

# ---- Offline / registry-disabled ----
Invoke-Fpi 'offline is-installed (cached)' 'Registry disabled (-r n/a) but package is cached.'  @('-c', $cachePath, '-r', 'n/a', 'is-installed', 'hl7.fhir.r4.core@4.0.1')
Invoke-Fpi 'offline install (cached)' 'Registry disabled, dependency tree already cached.'      @('-c', $cachePath, '-r', 'n/a', 'install', 'hl7.fhir.r4.core@4.0.1')

# ---- Failure cases ----
Invoke-Fpi 'install missing package'   'Should fail with non-zero exit.'                         @('-c', $cachePath, 'install', 'does.not.exist@9.9.9')
Invoke-Fpi 'offline check-latest'      'Registry disabled rejects "latest" resolution.'         @('-c', $cachePath, '-r', 'n/a', 'check-latest', 'hl7.fhir.r4.core')
Invoke-Fpi 'bad --request-timeout'     'parseIntOption rejects non-integer values.'              @('-c', $cachePath, '--request-timeout', 'notanumber', 'install', 'hl7.fhir.r4.core@4.0.1')

# ---- Auth flags smoke test ----
Invoke-Fpi 'auth flags smoke test' 'Verifies -t / --allow-http parse and the CLI still runs.'   @('-c', $cachePath, '-t', 'dummy-token', '--allow-http', 'get-cache')

Write-Host "`nDone. Results: $outFile"
