#!/usr/bin/env bash
set -euo pipefail

arch=$1
version=$(node -p 'require("./package.json").version')
image="$PWD/release/MemoryGalaxy-$version-macos-$arch.dmg"
stage=$(mktemp -d)
mount="$stage/image"
installed="$stage/Applications/Memory Galaxy.app"
group=mg-offline-ci
anchor=com.apple/400.memory-galaxy-ci
profile="$HOME/Library/Application Support/Memory Galaxy"
token=
group_created=false
anchor_loaded=false
mounted=false
cleanup() {
  if [[ $mounted == true ]]; then hdiutil detach "$mount" >/dev/null || true; fi
  if [[ $anchor_loaded == true ]]; then sudo pfctl -a "$anchor" -F rules >/dev/null || true; fi
  if [[ -n $token ]]; then sudo pfctl -X "$token" >/dev/null || true; fi
  if [[ $group_created == true ]]; then sudo dseditgroup -o delete "$group" || true; fi
  rm -rf -- "$stage"
}
trap cleanup EXIT

test ! -e "$profile"
mkdir -p "$mount" "$stage/Applications"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$image"
mounted=true
ditto "$mount/Memory Galaxy.app" "$installed"
hdiutil detach "$mount"
mounted=false
exe="$installed/Contents/MacOS/Memory Galaxy"
expected_arch=$arch
if [[ $arch == x64 ]]; then expected_arch=x86_64; fi
test "$(lipo -archs "$exe")" = "$expected_arch"
codesign --verify --deep --strict "$installed"
codesign -dv --verbose=4 "$installed" 2>&1 | grep -F 'Signature=adhoc'

# Limit the test process group, keeping the Actions runner itself connected.
sudo dseditgroup -o create "$group"
group_created=true
gid=$(dscl . -read "/Groups/$group" PrimaryGroupID | awk '{ print $2 }')
printf 'block drop out quick inet proto { tcp udp } from any to ! 127.0.0.0/8 group %s\nblock drop out quick inet6 proto { tcp udp } from any to ! ::1 group %s\n' "$gid" "$gid" > "$stage/pf.conf"
rules=$(sudo pfctl -sr)
if [[ -z $rules ]]; then
  sudo pfctl -f /etc/pf.conf
  rules=$(sudo pfctl -sr)
fi
grep -F 'anchor "com.apple/*"' <<<"$rules"
sudo pfctl -a "$anchor" -f "$stage/pf.conf"
anchor_loaded=true
token=$(sudo pfctl -E 2>&1 | awk '/Token *:/ { print $NF }')
test -n "$token"

offline() {
  # The hosted runner permits sudo to root. Drop all elevated IDs before executing the test.
  sudo -n /usr/bin/python3 -c '
import os
import sys

user, uid, gid, *args = sys.argv[1:]
os.initgroups(user, int(gid))
os.setgid(int(gid))
os.setuid(int(uid))
os.execv("/usr/bin/env", ["/usr/bin/env", *args])
' "$(id -un)" "$(id -u)" "$gid" "HOME=$HOME" "PATH=$PATH" \
    "MEMORY_GALAXY_INSTALLED_EXE=$exe" "MEMORY_GALAXY_EXPECTED_ARCH=$arch" \
    "MEMORY_GALAXY_PROFILE_DIRECTORY=$profile" "MEMORY_GALAXY_PROFILE_REPORT=$stage/profile.json" "$@"
}

test "$(offline id -u)" = "$(id -u)"
test "$(offline id -g)" = "$gid"
curl -4 --noproxy '*' -fsSI --max-time 12 https://api.github.com/ >/dev/null
if offline curl -4 --noproxy '*' -fsSI --max-time 5 https://api.github.com/ >/dev/null 2>&1; then
  echo 'PF isolation check reached the external host' >&2
  exit 1
fi
echo "The PF test group blocked external connections while retaining the runner user ID."
offline node --test tests/desktop/native.test.mjs
offline MEMORY_GALAXY_PROFILE_MODE=seed node --test tests/desktop/profile.test.mjs

database="$profile/library/memory-galaxy.sqlite3"
digest=$(shasum -a 256 "$database")
rm -rf -- "$installed"
test ! -e "$exe"
test "$digest" = "$(shasum -a 256 "$database")"
echo 'The DMG was mounted, the copied native app ran with outbound connections blocked, and removing the bundle preserved the default SQLite profile.'
node scripts/desktop-artifacts.mjs stage "macos-$arch"
