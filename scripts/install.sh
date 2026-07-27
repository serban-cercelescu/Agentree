#!/bin/sh
# Agentree installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/serban-cercelescu/Agentree/main/scripts/install.sh | sh
#
# Clones (or updates) the source into ~/.agentree/app, builds it, and installs
# the `agentree` command globally via npm. Idempotent: re-running updates an
# existing install. Deliberately avoids `npm install -g <git-url>` — several
# npm versions fail to reify a global git dependency with a prepare step.
set -eu

REPO_URL="https://github.com/serban-cercelescu/Agentree.git"
APP_DIR="${AGENTREE_HOME:-$HOME/.agentree}/app"

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "agentree installer: '$tool' is required but not found." >&2
    exit 1
  }
done

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing checkout in $APP_DIR…"
  git -C "$APP_DIR" fetch --quiet origin main
  git -C "$APP_DIR" reset --quiet --hard origin/main
else
  echo "Cloning into $APP_DIR…"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --quiet --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
echo "Installing dependencies and building…"
npm install --no-audit --no-fund

echo "Installing the agentree command…"
TARBALL="$(npm pack --silent | tail -n 1)"
npm install -g --no-audit --no-fund "$APP_DIR/$TARBALL"
rm -f "$TARBALL"

echo
echo "Done. Launch with: agentree"
