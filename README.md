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
5. 按需导出星盘 JSON，或点击「保存到本机」以便下次恢复。未主动保存的数据只留在当前页面内存中。

同一批次重复导入会按稳定身份去重。可选字段未出现时保留旧值；缺少的节点不会自动被删除。删除必须有明确的 1.1 删除记录并经过确认。

## 当前功能

- MGP 1.0 兼容迁移与 1.1，JSON / JSONL、稳定 ID、增量更新和显式删除
- 来源追溯、覆盖范围声明、逐项冲突与较新版本比较，删除墓碑防止旧数据静默复活
- Worker 校验与导入预览，文件拖放、可定位错误、取消、去重和确认边界
- 既有 Canvas 力导向星图、平移缩放、节点详情、文本搜索及分类筛选
- JSON 导出、用户主动本机保存、缓存清除

布局升级、编辑、时间线、快照、CI 和部署将在后续轮次处理，当前没有提供这些功能。

## 协议与数据

- [MGP 1.1 规范](docs/MGP.md)
- [JSON Schema](protocol/mgp.schema.json)
- [JSON 示例](protocol/sample.mgp.json) / [JSONL 示例](protocol/sample.mgp.jsonl)
- [产品导出提示词](protocol/export-prompt-zh.txt)
- [源码与导入审计](docs/AUDIT.md)

关系只来自导入数据，页面不会自行补充。`full` 是导出方的声明，无法证明已读取某个平台的全部记忆。所有正文、指令和 URL 都作为不可信文本处理，不会执行。

单批输入和合并后的紧凑 JSON 最大 12 MiB；每个工作区最多 50,000 个节点、250,000 条边。上限是数据处理边界，当前 Canvas 布局在大图下可能较慢。错误文档、未知版本、危险对象属性和失效引用会阻止应用。

本机存储使用未加密的 localStorage。`sensitive` 只是数据标记，不会使内容自动加密。应用没有远程账户、云同步或模型调用。

## 开发与测试

使用 Node.js 22 或更新版本：

```bash
npm ci
npm run check
npm test
```

首次运行浏览器测试需安装 Chromium：

```bash
npx playwright install chromium --only-shell
npm run test:e2e
```

浏览器测试包含桌面及手机尺寸的 Chromium。默认启动本地静态服务器；已有服务器时，可设置 `PLAYWRIGHT_BASE_URL`；已有 Chromium 可执行文件可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定，额外启动参数通过 `PLAYWRIGHT_CHROMIUM_ARGS` 的 JSON 数组提供。测试不连接模型，也不使用真实个人记忆。测试依赖与浏览器可在开发机器上安装，运行应用无需它们。

```bash
npm run build
```

构建仅将页面、协议和许可证复制到 `dist/`。没有将测试报告、源码仓库元数据或开发依赖放入静态产物。

## 致谢与许可

图谱交互与架构参考：[not-mental-model](https://github.com/R4ph3rd/not-mental-model)。

本项目采用 [MIT 许可证](LICENSE)。
