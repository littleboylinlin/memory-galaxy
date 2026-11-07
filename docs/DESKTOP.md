# Memory Galaxy 桌面版

从 [GitHub Release](https://github.com/littleboylinlin/memory-galaxy/releases) 下载对应架构的发行包和 `SHA256SUMS.txt`。在 Windows 可用 PowerShell 的 `Get-FileHash -Algorithm SHA256`，macOS 用 `shasum -a 256`，Linux 用 `sha256sum` 计算文件哈希并与清单核对。

| 平台                 | 文件                                       | 安装和移除                                                                                                                 |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Windows x64          | `MemoryGalaxy-Setup-0.7.0-x64.exe`         | 关闭旧版后运行安装程序即可覆盖升级。通过 Windows 的「已安装的应用」卸载，用户资料库保留。                                  |
| macOS Apple Silicon  | `MemoryGalaxy-0.7.0-macos-arm64.dmg`       | 打开 DMG，将 Memory Galaxy 拖到「应用程序」，然后弹出磁盘映像。移除时将应用移到废纸篓。                                    |
| macOS Intel          | `MemoryGalaxy-0.7.0-macos-x64.dmg`         | 安装和移除方式相同。                                                                                                       |
| Linux x64 · AppImage | `MemoryGalaxy-0.7.0-linux-x86_64.AppImage` | 用 `chmod +x` 添加执行权限后直接运行。移除时删除 AppImage 文件。                                                           |
| Linux x64 · deb      | `MemoryGalaxy-0.7.0-linux-amd64.deb`       | 用 `sudo apt install ./MemoryGalaxy-0.7.0-linux-amd64.deb` 安装，从应用菜单启动。用 `sudo apt remove memory-galaxy` 移除。 |

Windows 安装程序未签名，系统可能提示未知发布者。macOS 应用带临时签名（ad-hoc），无 Developer ID 签名和 Apple 公证。Gatekeeper 可能阻止带下载隔离标记的应用首次打开，受管设备可能禁止例外。系统允许时，可参考 Apple 的官方说明对该应用单独授权。[Apple 的 Gatekeeper 说明](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac)

三平台发行包都自带 Chromium 和 SQLite。Linux 需要桌面环境及系统库，deb 安装时如缺少依赖，需先准备相应软件包。AppImage 的挂载方式依赖系统的 FUSE 支持，发行包也支持 `APPIMAGE_EXTRACT_AND_RUN=1 ./MemoryGalaxy-0.7.0-linux-x86_64.AppImage`。Linux 桌面版要求 Chromium 沙盒可用。若发行版的用户命名空间策略限制 AppImage，可用 deb 的系统集成方式安装。

首次打开会看到示例星图。导入 MGP 或添加第一条自己的记忆即可开始。图谱修改点击「应用更改」后自动保存，看到「已保存到本机」表示 SQLite 事务已提交。回顾、收藏和主题包配置走同一资料库。主题包草稿仍需点击「保存配置」。关闭主窗口会退出程序。退出时会等待待写入的工作区和界面状态，有草稿或写入错误时会提示。

## 数据位置与恢复

| 平台    | 默认配置目录                                                           |
| ------- | ---------------------------------------------------------------------- |
| Windows | `%APPDATA%\Memory Galaxy`                                              |
| macOS   | `~/Library/Application Support/Memory Galaxy`                          |
| Linux   | `$XDG_CONFIG_HOME/Memory Galaxy`，未设置时为 `~/.config/Memory Galaxy` |

每个配置目录的 `library-location.json` 记录数据文件夹，默认 SQLite 文件位于该配置目录的 `library/memory-galaxy.sqlite3`。工具栏会显示当前路径。点击「更换数据文件夹」后，应用会确认是打开已有资料库，还是把现有资料复制到新位置。旧文件夹保留其原有资料。

请用当前账户可读写的本地目录保存资料。macOS 和 Linux 新建的 SQLite 文件默认只对当前账户开放。SQLite 回滚日志位于资料库同目录，异常退出后由 SQLite 处理。启动时会检查 SQLite 结构、资料库版本和每条记录的 SHA-256。校验失败时保留原资料库，可选择其他资料库或在新目录从备份恢复。磁盘写满、文件权限或 I/O 故障会中止事务。已应用但尚未写入的图谱可通过「另存工作区备份」保留。

## 完整备份与迁移

1. 在原电脑点击「导出完整资料备份」，用新文件名保存 JSON。备份包含图谱、来源、历史快照、操作记录、视图、主题包配置及差异基线、回顾和收藏。
2. 把 JSON 带到目标电脑，打开「恢复备份或迁移」。核对新增、同稳定 ID 的内容冲突和将移除的记录数量，再决定是否确认替换。
3. 有现有资料时，应用先在当前数据文件夹写入 `memory-galaxy-before-restore-*.json`，成功后提交恢复。可用这份文件回到原状态。

三平台采用相同的 SQLite 资料库与 `memory-galaxy/library-backup/1` 备份格式。跨电脑迁移用完整备份，避免把配置中的绝对目录路径一并带到另一台设备。从旧版 0.5.0 的工作区备份恢复时，只替换图谱、历史和星图视图，现有主题包、回顾与收藏会保留。

从网页版迁移时，用原浏览器配置打开原来的站点地址，关闭该星盘的其他标签页，应用要迁移的修改并保存主题包，再点击「下载桌面迁移包」。MGP JSON/JSONL 仍从「导入文件」处理，主题包 JSON 保留原格式。

资料在本机处理，数据库与导出的备份是明文。资料库的记录总量上限为 128 MiB，便携备份文件的读取上限为 132 MiB。

## 构建和验收

在目标平台使用 Node.js 24 执行 `npm ci`、`npm run test:storage`、`npm run desktop:pack`。打包默认选择当前系统和架构，产物写入 `release/`。原生验收可将 `MEMORY_GALAXY_INSTALLED_EXE` 指向已安装的程序或 Linux AppImage，再运行 `npm run test:desktop`。Linux 需要一个可用的桌面会话或 Xvfb。

- [三平台构建和验收记录](https://github.com/littleboylinlin/memory-galaxy/actions/workflows/ci.yml)
- [0.7.0 验收范围](VERIFICATION-0.7.0.md)
- [0.6.0 验收范围](VERIFICATION-0.6.0.md)
