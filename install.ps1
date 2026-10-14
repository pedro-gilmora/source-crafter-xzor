# xzor setup for Windows: .\install.ps1 [project-dir]
param([string]$dir = ".")
$ErrorActionPreference = "Stop"

$repo = "pedro-gilmora/source-crafter-xzor"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Location $dir
function Step([string]$text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Invoke-Checked([scriptblock]$command) { & $command; if ($LASTEXITCODE) { exit $LASTEXITCODE } }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Step "Installing Bun"
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

Step "Installing the compiler and the runtime"
Invoke-Checked { bun add -d @source-crafter/xzor typescript@^7 }
Invoke-Checked { bun add @source-crafter/xzor-runtime }

Step "Setting up the project"
Invoke-Checked { bun x xzor init }

if (Get-Command code -ErrorAction SilentlyContinue) {
    Step "Installing the VS Code extension"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "xzor-vsix-$PID"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        if (Get-Command gh -ErrorAction SilentlyContinue) { gh release download -R $repo -p "*.vsix" -D $tmp 2>$null }
        if (-not (Get-ChildItem $tmp -Filter *.vsix)) {
            try {
                $asset = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").assets | Where-Object name -like "*.vsix" | Select-Object -First 1
                if ($asset) { Invoke-WebRequest $asset.browser_download_url -OutFile (Join-Path $tmp $asset.name) -UseBasicParsing }
            } catch {}
        }
        $vsix = Get-ChildItem $tmp -Filter *.vsix | Select-Object -First 1
        if ($vsix) { code --install-extension $vsix.FullName --force }
        else { Write-Host "Could not download the extension; get the .vsix from https://github.com/$repo/releases" }
    } finally { Remove-Item -Recurse -Force $tmp }
}

Step "Ready"
Write-Host "  bun run dev      rebuilds dist/ on every save"
Write-Host "  bun x serve -s   serves the app (open the printed URL)"
