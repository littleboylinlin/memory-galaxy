# Memory Galaxy 桌面版

## 安装与首次使用

从对应的 GitHub Release 下载经过 Windows 安装测试的 `MemoryGalaxy-Setup-0.6.0-x64.exe` 和校验文件。用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 核对安装包，再运行安装程序。安装为当前 Windows 用户创建应用入口。安装包自带 Chromium，安装和运行可在离线时完成。当前构建配置使用未签名的安装包，Windows 可能显示未知发布者。

首次打开时会看到示例星图。导入 MGP 或添加第一条自己的记忆即可开始。图谱修改点击「应用更改」后自动保存，看到「已保存到本机」表示 SQLite 事务已提交。回顾、收藏和主题包配置走相同的资料库。主题包编辑器中的草稿仍需使用「保存配置」。正常关闭会等待待写入的工作区和界面状态，有草稿或写入错误时会要求选择返回或放弃未保存内容。

## 数据位置与恢复

默认资料库文件为 `%APPDATA%\Memory Galaxy\library\memory-galaxy.sqlite3`，启动器在同一应用配置目录的 `library-location.json` 记录所选文件夹。工具栏会显示当前数据文件夹。点击「更换数据文件夹」后，应用会确认是打开一份已有资料库，还是把现有资料复制到新位置。旧文件夹保留其原有资料。

在本地磁盘保管资料库。SQLite 回滚日志使用同目录下的 `memory-galaxy.sqlite3-journal`，发生异常退出时应用会让 SQLite 处理该文件。启动时会检查 SQLite 结构、资料库版本和每条记录的 SHA-256。校验失败会保留原资料库，并提供选择其他资料库或在新目录从备份恢复的入口。磁盘写满、文件权限或 I/O 故障会中止事务，应用会提示失败。已应用但仍未写入的图谱可以用「另存工作区备份」保留。

## 完整备份与迁移

1. 在原电脑点击「导出完整资料备份」，用一个新的文件名保存 JSON。文件包含图谱、来源、历史快照、操作记录、视图、主题包配置和差异基线、回顾与收藏。
2. 在目标电脑点击「恢复备份或迁移」，选择该 JSON。检查新增、同稳定 ID 的内容冲突和将移除的记录数量，再决定是否确认替换。
3. 有现有资料时，应用先在当前数据文件夹写入 `memory-galaxy-before-restore-*.json`。这份文件写入成功后才会提交恢复。恢复后可用它回到原状态。

从网页版迁移时，请在原来保存数据的浏览器、用户配置和站点地址打开已提供迁移按钮的版本，关闭同一星盘的其他标签页，应用想迁移的修改并保存主题包配置，然后点击「下载桌面迁移包」。从旧版 0.5.0 已经下载的工作区备份也能恢复，其中只有图谱、历史和星图视图。通过旧工作区文件恢复时，桌面端已有的主题包、回顾与收藏会保留。

完整资料使用 `memory-galaxy/library-backup/1`，旧版工作区使用 `memory-galaxy/backup/1`。MGP JSON/JSONL 从「导入文件」处理，主题包 JSON 按其原有格式供其他工具使用。所有资料处理均在本机进行。数据库和备份内容可直接读取，请把需要长期保留的备份另存于独立的磁盘。桌面资料库的记录总量上限为 128 MiB，便携备份文件读取上限为 132 MiB。

## 构建和验收

在 Windows x64 上安装 Node.js 24，执行：

```powershell
npm ci
npm run test:storage
npm run desktop:pack
```

安装包在 `release/`。Windows CI 在实际 Windows runner 上运行安装器，再对已安装的程序进行原生验证。需要单独复现时，先安装生成的包，将 `MEMORY_GALAXY_INSTALLED_EXE` 指向安装目录里的 `MemoryGalaxy.exe`，再运行 `npm run test:desktop`。网页版沿用原有 Pages 构建和部署流程。

- [Windows 构建和验收记录](https://github.com/littleboylinlin/memory-galaxy/actions/workflows/ci.yml)
- [0.6.0 验收范围](VERIFICATION-0.6.0.md)
