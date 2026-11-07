#!/usr/bin/env bash
set -euo pipefail

branch=fix/macos-offline-probe
feature_branch=feature/cross-platform-desktop
feature_commit=5ada577517821348832f2fdd113b1e217454ae13
merged_head() {
  local commit=$1 name=$2 pr
  pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$commit/pulls")
  jq -er --arg sha "$commit" --arg branch "$name" '
    map(select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha and .head.ref == $branch))
    | select(length == 1) | .[0].head.sha | select(test("^[0-9a-f]{40}$"))
  ' <<<"$pr"
}
head=$(merged_head "$GITHUB_SHA" "$branch")
feature_head=$(merged_head "$feature_commit" "$feature_branch")
test "$(jq -r .version package.json)" = 0.7.0

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
for target in windows-x64 macos-arm64 macos-x64 linux-x64; do
  gh run download "$GITHUB_RUN_ID" --name "desktop-$target" --dir "$stage/$target"
done
node scripts/desktop-artifacts.mjs verify "$stage"
(
  cd "$stage"
  sha256sum --check SHA256SUMS.txt
)

tag=v0.7.0
tag_head=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f 1)
if [[ -n "$tag_head" ]]; then
  test "$tag_head" = "$GITHUB_SHA"
fi
if ! gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  cat > "$stage/notes.md" <<NOTES
## Memory Galaxy 0.7.0

| 平台 | 发行包 |
| --- | --- |
| Windows x64 | NSIS 安装程序，支持从 0.6.0 覆盖升级 |
| macOS Apple Silicon | arm64 DMG |
| macOS Intel | x64 DMG |
| Linux x64 | AppImage 和 deb |

五个安装包的校验值列在 SHA256SUMS.txt。桌面版继续共用本地 SQLite 资料库、备份迁移和离线功能。

Windows 安装程序未签名。macOS 应用使用临时签名（ad-hoc），没有 Developer ID 签名和 Apple 公证。系统的 Gatekeeper 或组织策略可能限制下载后的首次打开。

- [安装、卸载和数据迁移](https://github.com/$GITHUB_REPOSITORY/blob/$GITHUB_SHA/docs/DESKTOP.md)
- [平台验收和测试边界](https://github.com/$GITHUB_REPOSITORY/blob/$GITHUB_SHA/docs/VERIFICATION-0.7.0.md)
- [与发行包对应的最终 CI](https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)
NOTES
  gh release create "$tag" "$stage"/MemoryGalaxy-* "$stage/SHA256SUMS.txt" \
    --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
    --title "Memory Galaxy 0.7.0" --notes-file "$stage/notes.md"
fi

test "$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f 1)" = "$GITHUB_SHA"
published=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")
jq -e '.draft == false and .prerelease == false and (.assets | length == 6)' <<<"$published"
for file in "$stage"/MemoryGalaxy-* "$stage/SHA256SUMS.txt"; do
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
  jq -e --arg name "${file##*/}" --arg digest "sha256:$digest" \
    'any(.assets[]; .name == $name and .digest == $digest)' <<<"$published"
done

remove_merged_branch() {
  local ref="refs/heads/$1" expected=$2 actual
  actual=$(git ls-remote origin "$ref" | cut -f 1)
  if [[ -n "$actual" ]]; then
    test "$actual" = "$expected"
    git push --force-with-lease="$ref:$expected" origin ":$ref"
  fi
  test -z "$(git ls-remote origin "$ref")"
}
gh auth setup-git --hostname github.com
remove_merged_branch "$branch" "$head"
remove_merged_branch "$feature_branch" "$feature_head"
