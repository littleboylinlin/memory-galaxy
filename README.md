# Memory Galaxy · 记忆星盘

把记忆与关系整理成可以探索的星图。通过开放的 MGP 格式接收任意来源的结构化数据，支持本地校验、差异预览和增量合并。星盘运行时不调用 AI 模型，也不上传记忆。

## 使用

在仓库根目录运行：

```bash
npm run dev
```

打开 <http://localhost:4173>。应用本身使用原生 JavaScript 与 Canvas，无构建步骤和运行时依赖。也可运行 `python -m http.server 8000`，然后打开 <http://localhost:8000>。

1. 复制页面中的导出提示词，让能访问记忆的 AI 输出 MGP 数据，或准备已有 JSON / JSONL 文件。
2. 粘贴内容、选择文件或将文件拖入页面，查看校验结果。错误可点击定位到具体行列。
3. 核对节点、关系、删除数量、来源与覆盖声明；同 ID 内容变化时逐项或批量处理冲突。
4. 点击「确认导入」后才应用整个批次。首次导入不会混入演示数据；取消和错误不改当前图谱。
5. 在星盘、记忆列表、时间线与来源页中浏览数据。点击星星查看出处，按依据编辑节点、状态和关系。
6. 按需导出 MGP，或下载包含历史和视图的完整备份。点击「保存到本机」或主动开启自动保存后，下次打开可恢复。未保存的数据只留在当前页面内存中。

同一批次重复导入会按稳定身份去重。可选字段未出现时保留旧值；缺少的节点不会自动被删除。删除必须有明确的 1.1 删除记录并经过确认。

## 当前功能

- MGP 1.0 兼容迁移与 1.1，JSON / JSONL、稳定 ID、增量更新和显式删除
- 来源追溯、覆盖范围声明、逐项冲突与较新版本比较，删除墓碑防止旧数据静默复活
- Worker 校验与导入预览，文件拖放、可定位错误、取消、去重和确认边界
- Worker 力导向布局，按类型、来源或真实连通关系分组；缩放平移、双指手势、节点拖动与固定、关系高亮
- 搜索定位、类型和状态筛选、分页记忆列表、来源与覆盖范围详情
- 节点及关系编辑、状态管理、更新时间线与本机操作记录
- 修改前快照、命名快照、撤销、MGP 导出与完整工作区备份恢复
- IndexedDB 主动保存、可选自动保存、旧缓存迁移、多页面写入提醒和缓存清除
- 小屏工具抽屉、键盘操作、原生弹窗和减少动态效果设置

已提供 GitHub Actions 检查、四个浏览器项目和 Pages 发布流程。生产发布只从 main 执行；首次需在仓库 Settings → Pages 中选择 GitHub Actions。线上状态以部署及发布后校验结果为准，配置文件存在不代表已经上线。

## 协议与数据

- [MGP 1.1 规范](docs/MGP.md)
- [JSON Schema](protocol/mgp.schema.json)
- [JSON 示例](protocol/sample.mgp.json) / [JSONL 示例](protocol/sample.mgp.jsonl)
- [产品导出提示词](protocol/export-prompt-zh.txt)
- [星盘操作、保存与备份说明](docs/WORKSPACE.md)
- [源码与数据路径审计](docs/AUDIT.md)
- [开发与贡献](CONTRIBUTING.md)
- [CI、构建校验与 Pages 部署](docs/DEPLOYMENT.md)

关系来自导入数据或用户明确创建，页面不会自行补充。`full` 是导出方的声明，无法证明已读取某个平台的全部记忆。所有正文、指令和 URL 都作为不可信文本处理，不会执行。

单批输入和合并后的紧凑 JSON 最大 12 MiB；每个工作区最多 50,000 个节点、250,000 条边。上限是数据处理边界。布局使用后台线程与空间聚合，渲染使用视野裁剪和细节数量限制；密集视图会明确提示省略情况，完整数据仍可在列表和导出中查看。不能据此保证所有设备上的大图帧率。错误文档、未知版本、危险对象属性和失效引用会阻止应用。

本机存储使用未加密的 IndexedDB，旧版 localStorage 缓存可读取迁移。快照最多保留 12 份、总计 16 MiB；长期保留请下载完整备份（最大 48 MiB）。`sensitive` 只是数据标记，不会使内容自动加密。应用没有远程账户、云同步或模型调用。

## 开发与测试

使用 Node.js 22 或更新版本：

```bash
npm ci
npm run check
npm test
```

首次运行浏览器测试需安装测试浏览器：

```bash
npx playwright install --with-deps
npm run test:e2e
```

浏览器测试包含桌面 Chromium、手机尺寸 Chromium、桌面 Firefox 和手机尺寸 WebKit。测试前会构建站点，随后从 `/memory-galaxy/` 子路径验证 `dist/`。已有站点时，可设置 `PLAYWRIGHT_BASE_URL`；已有 Chromium 可执行文件可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定，额外启动参数通过 `PLAYWRIGHT_CHROMIUM_ARGS` 的 JSON 数组提供，这些覆盖只影响 Chromium。测试不连接模型，也不使用真实个人记忆。测试依赖与浏览器可在开发机器上安装，运行应用无需它们。

```bash
npm run build
```

构建将页面、协议、图标和许可证复制到 `dist/`，生成包含 revision、文件大小和 SHA-256 的构建清单，并验证产物。未知文件、符号链接、测试报告、仓库元数据和开发依赖不会进入静态站点。运行 `npm run verify:build` 可复核完整性，`npm run preview` 可在 `http://localhost:4173/memory-galaxy/` 查看产物。

CI 在 Node.js 22、24 和四个浏览器项目通过后生成复核产物。main 的发布作业使用最小 Pages / OIDC 权限，再通过线上文件和浏览器检查验收。详细命令、首次启用与回退步骤见 [部署说明](docs/DEPLOYMENT.md)。

## 致谢与许可

图谱交互与架构参考：[not-mental-model](https://github.com/R4ph3rd/not-mental-model)。

本项目采用 [MIT 许可证](LICENSE)。

当前稳定性验收范围与限制见 [验收记录](docs/ACCEPTANCE.md)。
