# Memory Galaxy · MGP 1.0

开放记忆星盘原型。AI 按统一 JSON 格式输出节点与关系，星盘负责解析、校验、合并和可视化。**不需要 AI API。**

这是独立开发的兼容性实验，不是已经完整 Fork 的 `R4ph3rd/not-mental-model`。上游项目是重要的架构参考，后续可接入其图谱编辑器。

## 使用
直接访问 GitHub Pages（如果已启用），或者克隆并从 `web/` 启动：
```bash
cd web
python -m http.server 8000
```
打开 http://localhost:8000 。

## 功能
- 节点 = 星星，关系 = 连线，力导向布局、拖动平移、滚轮缩放、点击查看内容
- JSON 粘贴/文件导入、按 id 去重、增量合并与导出
- 中文通用导出提示词，一键复制给其他 AI
- MGP 1.0 规范：节点类别、状态、关系依据、来源覆盖范围
- 无远程服务与模型调用。默认仅内存存储；主动选择后才保存至浏览器 localStorage（不加密）
- 不会执行导入 JSON 中夹带的命令或提示词

## 范围
仅展示导入的数据，不保证各 AI 导出覆盖全部内存；来源 `full` 只是数据提供者声明。单批限制 50,000 节点 / 250,000 边以防恶意超大数据，Canvas 性能上限独立于协议规模。

## 开发
```bash
node --test tests/test-mgp.mjs
```
MIT license for this project's original source (no upstream source copied).
