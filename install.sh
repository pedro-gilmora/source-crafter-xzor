#!/usr/bin/env bash
# xzor setup for Linux and macOS: bash install.sh [project-dir]
set -euo pipefail

repo="pedro-gilmora/source-crafter-xzor"
mkdir -p "${1:-.}" && cd "${1:-.}"
step() { printf '\n\033[36m> %s\033[0m\n' "$1"; }

if ! command -v bun > /dev/null; then
  step "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

step "Installing the compiler and the runtime"
bun add -d @source-crafter/xzor typescript@^7
bun add @source-crafter/xzor-runtime

step "Setting up the project"
bun x xzor init

if command -v code > /dev/null; then
  step "Installing the VS Code extension"
  tmp=$(mktemp -d)
  if ! { command -v gh > /dev/null && gh release download -R "$repo" -p '*.vsix' -D "$tmp" 2> /dev/null; }; then
    url=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2> /dev/null | grep -o 'https://[^"]*\.vsix' | head -n 1 || true)
    if [ -n "$url" ]; then curl -fsSL -o "$tmp/xzor.vsix" "$url"; fi
  fi
  vsix=$(ls "$tmp"/*.vsix 2> /dev/null | head -n 1 || true)
  if [ -n "$vsix" ]; then code --install-extension "$vsix" --force; else echo "Could not download the extension; get the .vsix from https://github.com/$repo/releases"; fi
  rm -rf "$tmp"
fi

step "Ready"
echo "  bun run dev      rebuilds dist/ on every save"
echo "  bun x serve -s   serves the app (open the printed URL)"
