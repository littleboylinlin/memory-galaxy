#!/usr/bin/env bash
set -euo pipefail

version=0.8.0
tag=v$version
branch=feature/reliability-v080
test "$(jq -r .version package.json)" = "$version"
test "$(git ls-remote origin refs/heads/main | cut -f 1)" = "$GITHUB_SHA"
pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls")
head=$(jq -er --arg sha "$GITHUB_SHA" --arg branch "$branch" '
  map(select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha and .head.ref == $branch))
  | select(length == 1) | .[0].head.sha | select(test("^[0-9a-f]{40}$"))
' <<<"$pr")

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

tag_revision() {
  git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f 1
}
tag_head=$(tag_revision)
if [[ -n "$tag_head" ]]; then test "$tag_head" = "$GITHUB_SHA"; fi
if ! gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  cat > "$stage/notes.md" <<NOTES
## Memory Galaxy 0.8.0

- 可将现有 SQLite 资料库复制到新目录并加密。原明文库可用来回退。可用自选密码导出加密完整备份。
- 资料库复制与完整备份在写完后才发布。恢复前先保存可回滚副本。损坏文件和过期预览会阻止替换资料。
- 桌面首次启动提供导入与迁移入口。写入失败会保留界面内容并显示重试入口。
- 加快大图布局和重复搜索。MGP、主题包和旧版明文备份格式继续兼容。

| 平台 | 发行包 |
| --- | --- |
| Windows x64 | NSIS 安装程序，支持从 0.7.0 覆盖升级 |
| macOS Apple Silicon / Intel | 分别提供 arm64 和 x64 DMG |
| Linux x64 | AppImage 和 deb |

五份安装包的 SHA-256 校验值见 SHA256SUMS.txt。Windows 安装程序未签名，macOS 应用仅有 ad-hoc 签名，无 Developer ID 签名或 Apple 公证。

- [安装、加密与迁移](https://github.com/$GITHUB_REPOSITORY/blob/$GITHUB_SHA/docs/DESKTOP.md)
- [性能测试、验收范围与限制](https://github.com/$GITHUB_REPOSITORY/blob/$GITHUB_SHA/docs/VERIFICATION-0.8.0.md)
- [发行包对应的 CI](https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)
NOTES
  gh release create "$tag" "$stage"/MemoryGalaxy-* "$stage/SHA256SUMS.txt" \
    --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
    --title "Memory Galaxy $version" --notes-file "$stage/notes.md"
fi

test "$(tag_revision)" = "$GITHUB_SHA"
published=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")
jq -e '.draft == false and .prerelease == false and (.assets | length == 6)' <<<"$published"
for file in "$stage"/MemoryGalaxy-* "$stage/SHA256SUMS.txt"; do
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
  jq -e --arg name "${file##*/}" --arg digest "sha256:$digest" \
    'any(.assets[]; .name == $name and .digest == $digest)' <<<"$published"
done

ref="refs/heads/$branch"
actual=$(git ls-remote origin "$ref" | cut -f 1)
if [[ -n "$actual" ]]; then
  test "$actual" = "$head"
  cat > "$stage/pre-push" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
read -r local_ref local_sha remote_ref remote_sha
test "$local_ref" = '(delete)'
test "$remote_ref" = "$EXPECTED_DELETE_REF"
test "$remote_sha" = "$EXPECTED_DELETE_SHA"
! read -r extra
HOOK
  chmod +x "$stage/pre-push"
  gh auth setup-git --hostname github.com
  EXPECTED_DELETE_REF="$ref" EXPECTED_DELETE_SHA="$head" \
    git -c "core.hooksPath=$stage" push --delete origin "$branch"
fi
test -z "$(git ls-remote origin "$ref")"
