# Memory Galaxy · 记忆星盘

将记忆和关系整理成可以探索的星图。支持 MGP 1.0 格式的 JSON 导入、校验、增量合并和导出，使用原生 JavaScript 与 Canvas 在浏览器中运行，无需构建或配置 API。

## 使用

在仓库根目录启动本地静态服务器：

```bash
python -m http.server 8000
```

打开 <http://localhost:8000>。页面默认加载示例星图；可以导入自己的 JSON 文件，也可以复制页面中的导出提示词，让 AI 将可访问的记忆整理成 MGP 格式后粘贴导入。

## 功能

- 力导向星图，支持平移、缩放和节点详情查看
- 按标题、内容、类型及标签搜索，按节点类别筛选
- 粘贴、选择文件或拖放导入，按稳定 ID 合并多批数据
- 保留节点状态、关系依据和来源信息，推断关系使用虚线显示
- 导出 JSON，按需保存至当前浏览器或清除本地缓存

## 数据说明

记忆内容和关系均来自导入数据，页面不会自行补充或推断。来源的 `full` 标记是导出方的覆盖范围声明，星盘无法验证是否遗漏。

数据默认只保留在当前页面内存中；点击「保存到本机」后才写入浏览器本地存储，存储内容未加密。应用不上传记忆，也不执行导入内容中的脚本或指令。

单个导入文件最大 12 MiB，每批最多 50,000 个节点、250,000 条边；实际渲染性能取决于数据规模和设备。

## 文件

- `web/`：页面、Canvas 星图、协议校验与合并逻辑
- `protocol/mgp.schema.json`：MGP 1.0 JSON Schema
- `protocol/sample.mgp.json`：示例数据
- `protocol/export-prompt-zh.txt`：中文导出提示词
- `tests/`：协议与增量导入测试

## 开发

使用支持 `node:test` 的 Node.js 运行测试：

```bash
node --test tests/test-mgp.mjs
```

## 致谢与许可

图谱交互与架构参考：[not-mental-model](https://github.com/R4ph3rd/not-mental-model)。

本项目采用 [MIT 许可证](LICENSE)。
