# Memory Galaxy 桌面版

从 [GitHub Release](https://github.com/littleboylinlin/memory-galaxy/releases) 下载对应架构的发行包和 `SHA256SUMS.txt`。在 Windows 可用 PowerShell 的 `Get-FileHash -Algorithm SHA256`，macOS 用 `shasum -a 256`，Linux 用 `sha256sum` 计算文件哈希并与清单核对。

| 平台                 | 文件                                       | 安装和移除                                                                                                                 |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Windows x64          | `MemoryGalaxy-Setup-0.8.0-x64.exe`         | 关闭旧版后运行安装程序即可覆盖升级。通过 Windows 的「已安装的应用」卸载，用户资料库保留。                                  |
| macOS Apple Silicon  | `MemoryGalaxy-0.8.0-macos-arm64.dmg`       | 打开 DMG，将 Memory Galaxy 拖到「应用程序」，然后弹出磁盘映像。移除时将应用移到废纸篓。                                    |
| macOS Intel          | `MemoryGalaxy-0.8.0-macos-x64.dmg`         | 安装和移除方式相同。                                                                                                       |
| Linux x64 · AppImage | `MemoryGalaxy-0.8.0-linux-x86_64.AppImage` | 用 `chmod +x` 添加执行权限后直接运行。移除时删除 AppImage 文件。                                                           |
| Linux x64 · deb      | `MemoryGalaxy-0.8.0-linux-amd64.deb`       | 用 `sudo apt install ./MemoryGalaxy-0.8.0-linux-amd64.deb` 安装，从应用菜单启动。用 `sudo apt remove memory-galaxy` 移除。 |

Windows 安装程序未签名，系统可能提示未知发布者。macOS 应用带临时签名（ad-hoc），无 Developer ID 签名和 Apple 公证。Gatekeeper 可能阻止带下载隔离标记的应用首次打开，受管设备可能禁止例外。系统允许时，可参考 Apple 的官方说明对该应用单独授权。[Apple 的 Gatekeeper 说明](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac)

三平台发行包都自带 Chromium 和 SQLite。Linux 需要桌面环境及系统库，deb 安装时如缺少依赖，需先准备相应软件包。AppImage 的挂载方式依赖系统的 FUSE 支持，发行包也支持 `APPIMAGE_EXTRACT_AND_RUN=1 ./MemoryGalaxy-0.8.0-linux-x86_64.AppImage`。Linux 桌面版要求 Chromium 沙盒可用。若发行版的用户命名空间策略限制 AppImage，可用 deb 的系统集成方式安装。

首次打开可以导入已有记忆文件、从备份迁移，或先浏览示例星图。图谱修改点击「应用更改」后自动保存，看到「已保存到本机」表示 SQLite 事务已提交。回顾、收藏和主题包配置走同一资料库。主题包草稿仍需点击「保存配置」。关闭主窗口会退出程序。退出时会等待待写入的工作区和界面状态，有草稿或写入错误时会提示。

## 数据位置与恢复

| 平台    | 默认配置目录                                                           |
| ------- | ---------------------------------------------------------------------- |
| Windows | `%APPDATA%\Memory Galaxy`                                              |
| macOS   | `~/Library/Application Support/Memory Galaxy`                          |
| Linux   | `$XDG_CONFIG_HOME/Memory Galaxy`，未设置时为 `~/.config/Memory Galaxy` |

每个配置目录的 `library-location.json` 记录数据文件夹，默认 SQLite 文件位于该配置目录的 `library/memory-galaxy.sqlite3`。工具栏会显示当前路径。点击「更换数据文件夹」后，应用会确认是打开已有资料库，还是把现有资料复制到新位置。旧文件夹保留其原有资料。

请用当前账户可读写的本地目录保存资料。macOS 和 Linux 新建文件默认只对当前账户开放，Windows 文件继承目录的访问权限。SQLite 回滚日志位于资料库同目录，异常退出后由 SQLite 处理。启动时会检查 SQLite 结构、资料库版本和记录完整性。校验失败时可以重试打开、选择其他资料库，或在新目录从备份恢复。磁盘空间、权限或 I/O 错误会阻止提交。已应用但尚未保存的图谱可以重试写入或另存为工作区备份。

完整备份和新资料库在同一磁盘的私有暂存目录写完后才公开到目标文件名。请选择支持硬链接的本地文件系统，例如 NTFS、APFS 或 ext4。异常退出后可能留下 `.memory-galaxy-*` 暂存目录。成功重开原资料库并核对备份后，可在应用退出时移除确认由本次操作留下的暂存目录。

## 可选加密

点击「创建加密资料库副本」，自行设置至少 12 个字符的密码，再选择新目录。资料、主题包、收藏和视图一起复制。以后启动或切换到这份资料库时输入密码。原明文库仍在原目录，可用「更换数据文件夹」切回。已有明文资料库可以直接升级使用。加密资料库需要 0.8.0 或更新版本。

加密使用 scrypt 派生密钥、AES-256-GCM 加密记录和备份。资料库的 SQLite 结构、记录类别、数量和长度仍可观察，原文、来源、稳定 ID、视图及配置存为密文。应用不会保存、上传或代为生成密码。忘记密码后，需要从仍可打开的资料库或另一份可解锁的备份恢复。

在明文库中可以点击「用指定密码备份」，生成 `.mgbackup`。加密资料库默认用当前库密码加密完整备份，恢复前生成的回退备份也用同样的保护。选择「用指定密码备份」可为单份文件设置独立密码。手动导出的 MGP、主题包和工作区备份仍是明文。已存在的明文副本、系统交换空间和其他软件的同步范围由系统及存储位置决定。

## 完整备份与迁移

1. 在原电脑导出完整备份，用新文件名保存 JSON 或 `.mgbackup`。备份包含图谱、来源、历史快照、操作记录、视图、主题包配置及差异基线、回顾和收藏。
2. 把备份带到目标电脑，打开「恢复备份或迁移」。加密备份先输入密码，再核对新增、同稳定 ID 的冲突和将移除的记录数量。
3. 有现有资料时，应用先在当前数据文件夹写入 `memory-galaxy-before-restore-*` 完整备份，成功后提交恢复。可用这份文件回到原状态。

三平台采用相同的 SQLite 资料库与 `memory-galaxy/library-backup/1` 备份格式。跨电脑迁移用完整备份，避免把配置中的绝对目录路径一并带到另一台设备。从旧版 0.5.0 的工作区备份恢复时，只替换图谱、历史和星图视图，现有主题包、回顾与收藏会保留。

从网页版迁移时，用原浏览器配置打开原来的站点地址，关闭该星盘的其他标签页，应用要迁移的修改并保存主题包，再点击「下载桌面迁移包」。MGP JSON/JSONL 仍从「导入文件」处理，主题包 JSON 保留原格式。

资料在本机处理。资料库的记录总量上限为 128 MiB，明文备份文件的读取上限为 132 MiB。加密备份另有固定长度的版本、盐、随机数和认证标签。

## 构建和验收

在目标平台使用 Node.js 24 执行 `npm ci`、`npm run test:storage`、`npm run desktop:pack`。打包默认选择当前系统和架构，产物写入 `release/`。原生验收可将 `MEMORY_GALAXY_INSTALLED_EXE` 指向已安装的程序或 Linux AppImage，再运行 `npm run test:desktop`。Linux 需要一个可用的桌面会话或 Xvfb。

- [三平台构建和验收记录](https://github.com/littleboylinlin/memory-galaxy/actions/workflows/ci.yml)
- [0.8.0 验收范围](VERIFICATION-0.8.0.md)
- [0.7.0 验收范围](VERIFICATION-0.7.0.md)
- [0.6.0 验收范围](VERIFICATION-0.6.0.md)
