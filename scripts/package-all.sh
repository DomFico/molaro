#!/usr/bin/env bash
# Platform-targeted VSIXs. The Claude Agent SDK's assistant runtime is a
# platform-native binary that ships (in npm) only for the host platform
# (linux-x64 here, ~247 MB) and has NO pure-JS fallback. Rather than ship one
# 85 MB package that is dead weight — and a silently broken assistant — on every
# other platform, we build:
#   - linux-x64 WITH the native binary  → the assistant works (~85 MB)
#   - every other target WITHOUT it     → small; the viewer/terminal/grammar/plot/
#     selections/hand-written mods all work, and the assistant reports itself
#     unavailable through the verified error → auth-status: disconnected path.
# Build once, package each target.
set -euo pipefail
cd "$(dirname "$0")/.."

# The 247 MB native binary lives here; excluded via a TEMPORARY .vscodeignore
# entry (renaming it in-place does NOT work — vsce packages every node_modules
# file not matched by .vscodeignore, including a renamed dir).
NATIVE_IGNORE="node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**"
VER="0.1.0"

rm -rf dist
npm run build

pkg() { npx --yes @vscode/vsce package --target "$1" -o "viewer-${VER}-$1.vsix" >/dev/null 2>&1; }

# linux-x64: WITH the native binary (assistant works) — default .vscodeignore
pkg linux-x64

# other targets: exclude the native binary via a temporary .vscodeignore entry.
# Restore .vscodeignore on ANY exit so this script is never destructive.
cp .vscodeignore .vscodeignore.bak
trap 'mv -f .vscodeignore.bak .vscodeignore 2>/dev/null || true' EXIT
printf '\n# platform-targeted build: exclude the linux-x64 native binary\n%s\n' "$NATIVE_IGNORE" >> .vscodeignore
for t in darwin-x64 darwin-arm64 win32-x64; do pkg "$t"; done
mv -f .vscodeignore.bak .vscodeignore
trap - EXIT

echo "--- platform-targeted VSIX sizes ---"
for f in viewer-${VER}-*.vsix; do printf "%-40s %s\n" "$f" "$(du -h "$f" | cut -f1)"; done
