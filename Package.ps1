param(
    [Parameter(Mandatory=$false)]
    [string]$clean = "true",
    [Parameter(Mandatory=$false)]
    [string]$pack = "true",
    [Parameter(Mandatory=$false)]
    [string]$test = "false",
    [Parameter(Mandatory=$false)]
    [string]$specificVersion = $null,
    # Folder with one `<platform>/xzor[.exe]` per target, built by CI; empty packs the host build only.
    [Parameter(Mandatory=$false)]
    [string]$binaries = "",
    # `owner/name` of the GitHub repository, written into the packages' metadata.
    [Parameter(Mandatory=$false)]
    [string]$repository = ""
)

$ErrorActionPreference = "Stop"

# Sequential: the patch after the latest @source-crafter/xzor on npm, or 0.1.0 before the first publish.
function Get-Version {
    try { $latest = (Invoke-RestMethod "https://registry.npmjs.org/@source-crafter%2Fxzor/latest").version } catch { return "0.1.0" }
    $major, $minor, $patch = $latest.Split('.')
    return "$major.$minor.$([int]$patch + 1)"
}

function Invoke-Step([string]$name, [scriptblock]$step) {
    Write-Host "
PACKER: $name
"
    & $step
    if ($LASTEXITCODE -ne 0) { throw "PACKER: '$name' failed with exit code $LASTEXITCODE" }
}

function Write-Json([string]$path, $value) {
    $json = $value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

$root = $PSScriptRoot
Set-Location $root
Write-Host "Current path: $root"

$version = if ($specificVersion) { $specificVersion } else { Get-Version }
$publish = Join-Path $root "publish"
$stage = Join-Path $publish "stage"
$hostTarget = "$(if ($IsWindows) { 'win32' } elseif ($IsMacOS) { 'darwin' } else { 'linux' })-$(if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' })"
$platforms = @{ "win32-x64" = @("win32", "x64"); "linux-x64" = @("linux", "x64"); "darwin-arm64" = @("darwin", "arm64") }

Write-Host "CONFIG: version = $version, clean = $clean, pack = $pack, test = $test, binaries = '$binaries', repository = '$repository'
"

if ($clean -eq "true" -and (Test-Path $publish)) {
    Write-Host "PACKER: Removing packages"
    Remove-Item -Recurse -Force $publish
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Invoke-Step "Restoring..." { bun install --frozen-lockfile }
Invoke-Step "Fetching crates..." { cargo fetch }

Invoke-Step "Building the compiler" { cargo build --release }
Invoke-Step "Building the editor extension" { bun run build:vscode }

if ($test -eq "true") {
    Invoke-Step "Testing the compiler" { cargo test }
    # Bare `bun test` would also run the scratch copies under target/.
    Invoke-Step "Testing the runtime, the build and the language server" { bun test ./runtime ./tests }
    Invoke-Step "Testing the grammar" { bun run test:grammar }
}

if ($pack -ne "true") { return }

$repositoryField = if ($repository) { @{ type = "git"; url = "https://github.com/$repository.git" } } else { $null }

function Stage-Package([string]$name, [string]$from, $manifest) {
    $dir = Join-Path $stage $name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if ($from) { Copy-Item -Recurse -Force "$from/*" $dir }
    $manifest.version = $version
    if ($repositoryField) { $manifest | Add-Member -Force -NotePropertyName repository -NotePropertyValue $repositoryField }
    Write-Json (Join-Path $dir "package.json") $manifest
    Push-Location $dir
    try { Invoke-Step "Packing $($manifest.name)" { bun pm pack --destination $publish --quiet } } finally { Pop-Location }
}

# Runtime: JavaScript plus declarations, so tsc in user projects doesn't check its source under their settings.
# One file per module, imports kept: a bundle then keeps only the `dom` bindings an app calls.
$runtimeOut = Join-Path $stage "runtime-build"
Invoke-Step "Building the runtime" { bun build runtime/index.ts runtime/bindings.ts runtime/dom.ts runtime/track.ts runtime/model.ts runtime/entity-set.ts --outdir $runtimeOut --target browser --format esm --sourcemap=linked --external "./*" }
# index stays external so HttpError is the one class of the main export.
Invoke-Step "Building the runtime server" { bun build runtime/server.ts --outdir $runtimeOut --target bun --format esm --external "*/index" --sourcemap=linked }
Invoke-Step "Emitting the runtime declarations" {
    bun x tsc runtime/index.ts runtime/model.ts runtime/server.ts --declaration --emitDeclarationOnly --outDir $runtimeOut --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM,ESNext.Disposable,ESNext.Decorators --types bun --strict --skipLibCheck
}
$runtime = Get-Content npm/runtime/package.json -Raw | ConvertFrom-Json
Stage-Package "runtime" $runtimeOut $runtime

# One package per platform binary; the launcher package depends on all of them at this version.
$packed = @()
foreach ($target in $platforms.Keys | Sort-Object) {
    $exe = if ($target.StartsWith("win32")) { "xzor.exe" } else { "xzor" }
    $source = if ($binaries) { Join-Path $binaries "$target/$exe" } elseif ($target -eq $hostTarget) { Join-Path $root "target/release/$exe" } else { $null }
    if (-not $source -or -not (Test-Path $source)) {
        Write-Host "PACKER: No binary for $target, skipped"
        continue
    }
    $dir = Join-Path $stage "cli-$target"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -Force $source (Join-Path $dir $exe)
    $os, $cpu = $platforms[$target]
    Stage-Package "cli-$target" $null ([pscustomobject]@{
        name = "@source-crafter/xzor-cli-$target"
        version = $version
        description = "The xzor compiler for $target"
        license = "MIT"
        os = @($os)
        cpu = @($cpu)
        files = @($exe)
    })
    $packed += $target
}

$launcher = Get-Content npm/xzor/package.json -Raw | ConvertFrom-Json
foreach ($dep in @($launcher.optionalDependencies.PSObject.Properties.Name)) { $launcher.optionalDependencies.$dep = $version }
$launcher.peerDependencies."@source-crafter/xzor-runtime" = $version
Stage-Package "xzor" "npm/xzor" $launcher

# The extension: its own manifest gets the version and repository; vsce packs from editors/vscode.
$extensionManifest = Join-Path $root "editors/vscode/package.json"
$original = Get-Content $extensionManifest -Raw
try {
    $extension = $original | ConvertFrom-Json
    $extension.version = $version
    if ($repositoryField) { $extension | Add-Member -Force -NotePropertyName repository -NotePropertyValue $repositoryField }
    Write-Json $extensionManifest $extension
    $vsix = Join-Path $publish "xzor-$version.vsix"
    $flags = @("--no-dependencies", "--skip-license") + $(if ($repositoryField) { @() } else { @("--allow-missing-repository") })
    Push-Location editors/vscode
    try { Invoke-Step "Packing the editor extension" { bun x @vscode/vsce package @flags -o $vsix } } finally { Pop-Location }
} finally {
    [System.IO.File]::WriteAllText($extensionManifest, $original, (New-Object System.Text.UTF8Encoding($false)))
}

Remove-Item -Recurse -Force $stage
Write-Host "
PACKER: Packed $version for $($packed -join ', ') into $publish
"
Get-ChildItem $publish -Name
