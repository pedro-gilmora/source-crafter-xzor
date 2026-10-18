# Builds the Visual Studio extension: `editors/vs/build.ps1 -version 1.2.3 -server target/release/xzor.exe -out publish/xzor-vs-1.2.3.vsix`.
# The manifest takes the version for the build only, and the server binary ships inside the .vsix.
# `-offline` compiles against the installed Visual Studio instead of the NuGet packages.
param(
    [Parameter(Mandatory = $true)][string]$version,
    [string]$server = "",
    [string]$msbuild = "",
    [string]$out = "",
    [switch]$offline
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
if (-not $msbuild) { $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1 }
if (-not $msbuild) { throw "Visual Studio's MSBuild was not found" }

$manifest = Join-Path $here "source.extension.vsixmanifest"
$original = Get-Content $manifest -Raw
$serverDir = Join-Path $here "server"
try {
    [System.IO.File]::WriteAllText($manifest, ($original -replace '(<Identity [^>]*Version=")[^"]*', "`${1}$version"), (New-Object System.Text.UTF8Encoding($false)))
    if ($server -and (Test-Path $server)) {
        New-Item -ItemType Directory -Force $serverDir | Out-Null
        Copy-Item -Force $server (Join-Path $serverDir "xzor.exe")
    }
    # Rebuild: the intermediate manifest would otherwise keep the previous version.
    $flags = @("/restore", "/t:Rebuild", "/p:Configuration=Release", "/v:minimal", "/nologo")
    if ($offline) {
        $vs = & $vswhere -latest -products * -property installationPath
        $flags += @("/p:VsInstallRoot=$vs", "/p:RestoreSources=$(Join-Path $env:USERPROFILE '.nuget/packages')")
    }
    & $msbuild (Join-Path $here "Xzor.VisualStudio.csproj") @flags
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($out) { Copy-Item -Force (Join-Path $here "bin/Release/net472/xzor-vs.vsix") $out }
} finally {
    [System.IO.File]::WriteAllText($manifest, $original, (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item -Recurse -Force $serverDir -ErrorAction SilentlyContinue
}
