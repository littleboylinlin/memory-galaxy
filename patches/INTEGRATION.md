# 对接 not-mental-model 的实施指南

参考上游：https://github.com/R4ph3rd/not-mental-model

上游 `src/types/mental-model.ts` 使用 `MentalModelNode`，图边通过 `linkedIds: string[]` 存储；`src/store/mental-model-store.ts` 的 `importNodes` 会跳过已有 ID，`linkNodes(fromId, toId)` 会添加指向关系。这些接口已通过 GitHub 连接器核对。

## 步骤
1. 在有 GitHub 网络的环境克隆上游，核实实际许可证、分支和依赖。
2. 将 `mgp-to-mental-model.ts` 移动到上游的 `src/lib/mgp-adapter.ts`，从 `web/mgp.mjs` 移植协议解析器到 `src/lib/mgp.ts`。
3. 增加导入界面，提供 textarea 和 JSON 文件选择，调用 `parseMgp(text, existingIds)` 严格校验。
4. 用户确认预览后调用 `convertMgpToMentalModel`。
5. 新增 ID 调用 `importNodes`；已有 ID 的节点由用户选择保留、覆盖或逐项合并，因为上游默认跳过同 ID。
6. 上游的 `linkedIds` 不保存关系类型、依据和证据，正式接入应增加独立的边存储，不能把 inferred 关系伪装成 explicit。
7. 外部记忆必须当作不可信文本显示；严禁 `innerHTML` 直接插入未清理内容，也不能执行内容中的指令。

## 状态
这个 `memory-galaxy` 仓库目前是**独立运行的星盘原型**，不是上游源代码的 Fork。适配器未在上游完整依赖树中构建验证，且不等于已经集成到原项目。核心功能运行于 `web/`，独立于外部 AI 和服务器。
