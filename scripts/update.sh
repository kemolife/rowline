#!/bin/zsh
# Updates uDB (formerly Rowline) in /Applications to the latest code of this checkout's branch.
# Your connections, passwords, saved queries and history stay: they live in
# ~/Library/Application Support/app.rowline.desktop/, not in the app.
#
#   ./scripts/update.sh            pull, build, install
#   ./scripts/update.sh --no-pull  build and install what is checked out now
set -euo pipefail
cd "${0:A:h}/.."

APP=/Applications/uDB.app
OLD_APP=/Applications/Rowline.app
BUNDLE=src-tauri/target/release/bundle/macos/uDB.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# the app binary is still called rowline inside both uDB.app and the old Rowline.app
if pgrep -f "\.app/Contents/MacOS/rowline" >/dev/null; then
  echo "uDB (or the old Rowline) is running. Quit it (⌘Q) and run this again." >&2
  exit 1
fi

if [[ "${1:-}" != "--no-pull" ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "You have local changes. Commit or stash them, or run with --no-pull." >&2
    exit 1
  fi
  git pull --ff-only
fi

npm install --no-audit --no-fund
npm run tauri build -- --bundles app

# replace the old app; an ad-hoc signature keeps macOS from calling the copied app damaged
rm -rf "$APP"
# the app was called Rowline before; your data is not inside it, so removing it loses nothing
if [[ -d "$OLD_APP" ]]; then
  "$LSREGISTER" -u "$OLD_APP" 2>/dev/null || true
  rm -rf "$OLD_APP"
  echo "Removed the old Rowline.app. If it is in your Dock, remove it there and add uDB."
fi
ditto "$BUNDLE" "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify "$APP"

# the Dock and Finder pick up the new icon and version
"$LSREGISTER" -u "$BUNDLE" 2>/dev/null || true
rm -rf "$BUNDLE"
"$LSREGISTER" -f "$APP"

# the command line: links made before point at the old app path, so make them again
if [[ -L "$HOME/.local/bin/rowline" || -L "$HOME/.local/bin/udb" ]]; then
  "$APP/Contents/MacOS/rowline" install
fi

echo "uDB updated: $(git log -1 --format='%h %s')"
