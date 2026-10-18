# Publishes the Visual Studio extension to the Visual Studio Marketplace:
# `editors/vs/publish.ps1 -vsix publish/xzor-vs-1.2.3.vsix -token <Marketplace PAT>`.
# VsixPublisher comes from the VSSDK build tools package, restored if missing. A version already published counts as done.
param(
    [Parameter(Mandatory = $true)][string]$vsix,
    [Parameter(Mandatory = $true)][string]$token
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$buildTools = Join-Path $env:USERPROFILE ".nuget/packages/microsoft.vssdk.buildtools"
if (-not (Test-Path $buildTools)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
    $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
    & $msbuild (Join-Path $here "Xzor.VisualStudio.csproj") /t:Restore /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
# The copy under lib/ starts without the telemetry assembly conflict the top-level one can hit.
$publisher = Get-ChildItem $buildTools -Recurse -Filter VsixPublisher.exe | Sort-Object { $_.FullName -match '\\lib\\' } -Descending | Select-Object -First 1
if (-not $publisher) { throw "VsixPublisher.exe was not found under $buildTools" }

$output = & $publisher.FullName publish -payload (Resolve-Path $vsix) -publishManifest (Join-Path $here "publishManifest.json") -personalAccessToken $token 2>&1 | Out-String
Write-Host $output
if ($LASTEXITCODE -ne 0 -and $output -notmatch "already exists") { exit $LASTEXITCODE }
exit 0
