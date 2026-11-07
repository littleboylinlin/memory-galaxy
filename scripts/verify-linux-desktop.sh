#!/usr/bin/env bash
set -euo pipefail

version=$(node -p 'require("./package.json").version')
deb=$(realpath "release/MemoryGalaxy-$version-linux-amd64.deb")
appimage=$(realpath "release/MemoryGalaxy-$version-linux-x86_64.AppImage")
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/config"
cp "$appimage" "$stage/Memory Galaxy.AppImage"
chmod +x "$stage/Memory Galaxy.AppImage"

test "$(dpkg-deb -f "$deb" Architecture)" = amd64
sudo apt-get install -y --no-install-recommends --download-only "$deb"
sudo unshare --net -- apt-get install -y --no-install-recommends --no-download "$deb"
exe=$(dpkg-query -L memory-galaxy | awk '/^\/opt\/.*\/memory-galaxy$/')
test -x "$exe"
test "$(stat -c %u "$exe")" = 0
desktop=$(dpkg-query -L memory-galaxy | awk '/^\/usr\/share\/applications\/.*\.desktop$/')
desktop-file-validate "$desktop"
grep -q '^Exec=.*memory-galaxy' "$desktop"

offline() {
  sudo unshare --net -- bash -euc '
    ip link set lo up
    test "$(ip -o link show | wc -l)" -eq 1
    test -z "$(ip route show default)"
    test -z "$(ip -6 route show default)"
    user=$1
    shift
    exec sudo -u "$user" -- "$@"
  ' bash "$(id -un)" env "HOME=$HOME" "PATH=$PATH" \
    "XDG_CONFIG_HOME=$stage/config" \
    "MEMORY_GALAXY_PROFILE_DIRECTORY=$stage/config/Memory Galaxy" \
    "MEMORY_GALAXY_PROFILE_REPORT=$stage/profile.json" MEMORY_GALAXY_EXPECTED_ARCH=x64 \
    "$@"
}

offline unshare -Ur true
offline "MEMORY_GALAXY_INSTALLED_EXE=$exe" \
  xvfb-run -a node --test tests/desktop/native.test.mjs
offline "MEMORY_GALAXY_INSTALLED_EXE=$exe" MEMORY_GALAXY_PROFILE_MODE=seed \
  xvfb-run -a node --test tests/desktop/profile.test.mjs
offline "MEMORY_GALAXY_INSTALLED_EXE=$stage/Memory Galaxy.AppImage" APPIMAGE_EXTRACT_AND_RUN=1 \
  xvfb-run -a node --test tests/desktop/native.test.mjs
offline "MEMORY_GALAXY_INSTALLED_EXE=$stage/Memory Galaxy.AppImage" APPIMAGE_EXTRACT_AND_RUN=1 \
  MEMORY_GALAXY_PROFILE_MODE=check xvfb-run -a node --test tests/desktop/profile.test.mjs

database="$stage/config/Memory Galaxy/library/memory-galaxy.sqlite3"
digest=$(sha256sum "$database")
sudo unshare --net -- dpkg --purge memory-galaxy
test ! -e "$exe"
test ! -e "$desktop"
rm -- "$stage/Memory Galaxy.AppImage"
test "$digest" = "$(sha256sum "$database")"
echo 'The deb was installed and purged without networking. The AppImage ran from its release file via extract-and-run. Both removals preserved the default SQLite profile.'
node scripts/desktop-artifacts.mjs stage linux-x64
