#!/usr/bin/env bash
# Is what is INSTALLED what is in the repo?
#
# This exists because the same mistake happened twice in one session: a shipped mod
# was edited, the change was verified by running the file in the repo, and the owner
# was told it was fixed — while the extension went on running the previous VSIX. The
# repo copy and the installed copy are different artifacts and only a comparison can
# tell them apart. "I edited it" is not evidence.
#
# Covers BOTH halves, because they fail independently:
#   - dist/    — a rebuild that was never packaged
#   - mods/    — a mod file edited after the last package (the one that bit us; mods
#                are DATA in the VSIX, so no build step touches them and nothing
#                anywhere else notices they are stale)
#   - producer/*.py — same reason as mods: shipped verbatim, never built
#
# Exit 0 = installed matches the repo. Non-zero = do not tell anyone it is fixed.
set -uo pipefail
cd "$(dirname "$0")/.."

# DISCOVER the install, do not hardcode it. Two things were wrong with the old
# literal `$HOME/.vscode/extensions/undefined_publisher.viewer-0.1.0`:
#   * Remote-SSH — the only mode that matters on a cluster — installs into
#     ~/.vscode-server/extensions, so this script was unusable there without an
#     override. Measured on a real cluster install.
#   * it embeds `undefined_publisher`, so it breaks the moment a real publisher
#     is set, which is the very next thing a marketplace release does.
# Name and version come from package.json, the publisher is whatever is actually
# on disk, and both extension roots are searched.
EXT="${MOLARO_EXT_DIR:-}"
if [ -z "$EXT" ]; then
  name=$(node -p "require('./package.json').name" 2>/dev/null || echo viewer)
  ver=$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)
  for root in "$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions"; do
    [ -d "$root" ] || continue
    # any publisher, exact name + version
    for cand in "$root"/*."$name-$ver"; do
      [ -d "$cand" ] && EXT="$cand" && break 2
    done
  done
fi
if [ -z "$EXT" ] || [ ! -d "$EXT" ]; then
  echo "check-installed: no installed extension found (looked for *.${name:-viewer}-${ver:-?}" >&2
  echo "  under ~/.vscode-server/extensions and ~/.vscode/extensions; set MOLARO_EXT_DIR to override)" >&2
  exit 2
fi

fail=0
check() {                      # check <repo-relative path>
  local rel="$1"
  local a b
  [ -f "$rel" ] || return 0
  if [ ! -f "$EXT/$rel" ]; then
    printf '  %-34s MISSING from the install\n' "$rel"; fail=1; return
  fi
  a=$(sha256sum "$rel"        | cut -c1-16)
  b=$(sha256sum "$EXT/$rel"   | cut -c1-16)
  if [ "$a" = "$b" ]; then
    printf '  %-34s ok   %s\n' "$rel" "$a"
  else
    printf '  %-34s STALE  repo=%s installed=%s\n' "$rel" "$a" "$b"; fail=1
  fi
}

echo "installed vs repo  ($EXT)"
check dist/extension.cjs
check dist/webview/main.js
check dist/webview/terminal.js
check dist/webview/plot.js
for f in mods/*.py producer/*.py contract/contract.py; do check "$f"; done

# A mod present in the install but NOT in the repo is equally wrong — it means a
# removed mod is still shipping. The roster test pins the repo side; this pins that
# the install agrees with it.
for f in "$EXT"/mods/*.py; do
  rel="mods/$(basename "$f")"
  if [ ! -f "$rel" ]; then
    printf '  %-34s INSTALLED BUT NOT IN THE REPO\n' "$rel"; fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK — the installed extension is the repo."
else
  echo "STALE — run: npm run package && code --install-extension viewer-0.1.0-linux-x64.vsix --force" >&2
fi
exit "$fail"
