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
  if [ -n "$vsix" ]; then
    # `code` alone only reaches the default profile: install into every user profile too.
    case "$(uname -s)" in
      Darwin) storage="$HOME/Library/Application Support/Code/User/globalStorage/storage.json" ;;
      *) storage="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User/globalStorage/storage.json" ;;
    esac
    profiles=""
    if [ -f "$storage" ]; then
      profiles=$(bun -e 'const s = await Bun.file(process.argv[1]).json(); for (const p of s.userDataProfiles ?? []) if (!String(p.location).startsWith("builtin/")) console.log(p.name)' "$storage" 2> /dev/null || true)
    fi
    export NODE_NO_WARNINGS=1
    # Earlier ids of this extension (xzor.xzor, PedroGilMora.xzor); two copies would both start a language server.
    for old in xzor.xzor PedroGilMora.xzor; do
      code --uninstall-extension "$old" > /dev/null 2>&1 || true
      while IFS= read -r name; do
        [ -n "$name" ] && { code --profile "$name" --uninstall-extension "$old" > /dev/null 2>&1 || true; }
      done <<< "$profiles"
    done
    code --install-extension "$vsix" --force
    while IFS= read -r name; do
      [ -n "$name" ] && code --profile "$name" --install-extension "$vsix" --force
    done <<< "$profiles"
    echo "Installed $(basename "$vsix") in the default profile${profiles:+ and $(echo "$profiles" | paste -sd, -)}. Reload VS Code to use it."
  else
    echo "Could not download the extension; get the .vsix from https://github.com/$repo/releases"
  fi
  rm -rf "$tmp"
fi

step "Ready"
echo "  bun run dev   builds, serves the app (open the printed URL) and reloads it on every save"
