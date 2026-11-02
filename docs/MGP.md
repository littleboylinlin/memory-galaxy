# Memory Graph Protocol 1.1

MGP 描述记忆节点、关系、来源和显式删除操作。星盘只处理数据；任何来源都可以输出此格式，运行时不需要模型服务。

## 文档与版本

```json
{
  "protocol": "mgp/1.1",
  "mode": "snapshot",
  "source": {
    "id": "notes:conversation:stable-key",
    "platform": "notes",
    "scope": "本次实际可访问的对话",
    "completeness": "partial"
  },
  "nodes": [
    {
      "id": "notes:memory:stable-key",
      "label": "学习计划",
      "type": "goal",
      "content": "保留来源中的原文或忠实概括。",
      "state": "confirmed",
      "source_ref": "conversation:stable-key/message:12"
    }
  ],
  "edges": []
}
```

必须提供 `protocol`、`source`、`nodes` 和 `edges`。空数组有效。支持 `mgp/1.0` 和 `mgp/1.1`，不自动接受未知版本；合并结果统一导出为 1.1。

`mode` 可选，为 `snapshot` 或 `delta`。两者都按稳定 ID 合并；**snapshot 不表示替换工作区，也不会删除本批未出现的记录**。`batch_id` 是可选的来源批次标识，不充当节点版本号；重复批次仍通过记录身份和内容去重。

1.0 文档中未定义的普通自定义字段会迁移到对应记录的 `extensions["mgp:legacy-fields"]`，已有同名扩展则使用带数字后缀的命名空间，避免覆盖。预览会提示迁移。1.1 文档拒绝未知字段，自定义内容统一放入 `extensions`。新增协议保留字段须遵守其类型；1.0 不能携带 `mode: delta` 或删除操作。

JSON Schema 位于 [mgp.schema.json](../protocol/mgp.schema.json)。Schema 检查结构和字段类型；跨记录引用、重复 ID、来源声明一致性、深度和总字节数等约束由运行时校验补充。

## 稳定身份

节点 `id` 由导出方维护，建议采用 `platform:scope:stable-key`。更新同一记忆时沿用 ID；不要以批次中的行号生成身份。ID 不能为空或全为空白，最长 256 字符，不允许控制字符。

关系可选用自己的稳定 `id`。有 ID 时，以该 ID 识别关系，支持保持身份并修改端点或关系类型；没有 ID 时，以有序三元组 `(from, to, type)` 识别。有 ID 与无 ID 的身份空间分离。不会根据文字相似程度猜测两条记忆是否相同，也不会合并两个不同的显式关系 ID。

1.1 单批中的重复节点 ID 或关系身份是错误。1.0 重复关系沿用去重行为并给出提示。跨批次相同身份、相同有效内容的记录保持不变；不会增加星星数量。

## 节点与关系

节点必须有 `id`、`label`、`type`，其中标题为 1～200 字符。类型支持：

`memory`、`person`、`project`、`topic`、`event`、`preference`、`goal`、`skill`、`other`。

可选字段：

| 字段                      | 含义                                                   |
| ------------------------- | ------------------------------------------------------ |
| `content`                 | 文本，最长 100,000 字符                                |
| `tags`                    | 最多 100 个非空标签，每项最长 100 字符                 |
| `state`                   | confirmed / inferred / deprecated / disputed / unknown |
| `updated_at`              | 带时区、精确到秒的 ISO 8601 日期时间，可带小数秒       |
| `revision`                | 来源维护的正安全整数版本号                             |
| `source_id`、`source_ref` | 已声明的来源 ID 与可追溯引用                           |
| `provenance`              | 多条来源引用，格式见下文                               |
| `sensitive`               | 布尔标记；不会自动加密内容                             |
| `extensions`              | 自定义 JSON 对象                                       |

关系必须有 `from`、`to`、`type`、`basis`。端点必须存在于本批节点或当前工作区，且不能同时被本批删除。`basis` 为 `explicit`、`inferred` 或 `rule`；可用 `evidence` 保存依据，最长 10,000 字符。关系同样支持 `updated_at`、`revision`、`source_id`、`source_ref`、`provenance` 和 `extensions`。

关系只来自输入；布局、分类、文字相似度和共同标签不会生成关系。推断关系保留原始 `inferred` 标记。

## 来源与覆盖

`source.id` 必填；`platform`、`scope`、`completeness`、`exported_at` 可选。`completeness` 为 `full`、`partial` 或 `unknown`，缺省按未知处理。`full` 始终是导出方的声明，不能证明已读取平台全部记忆。

多来源文档可通过 `sources` 数组声明其他来源。相同来源 ID 的重复或矛盾声明不能静默覆盖。合并时来源元数据变化也进入冲突预览。

```json
{
  "source_id": "notes:conversation:stable-key",
  "source_ref": "message:12",
  "provenance": [
    { "source_id": "notes:conversation:stable-key", "ref": "message:12" }
  ]
}
```

记录未提供 `source_id` 时继承本批来源。合并会保留已有来源追溯；相同来源与引用去重。`provenance` 的来源必须已声明，不能凭空引用另一个平台。

工作区导出使用 `workspace:local` 作为汇总来源，实际来源保存在 `sources` 和各记录中。旧版已合并数据如果只留下 `merged` 而没有逐项来源，会保留这个未知的合并来源，不会反推每条记忆来自哪个平台。

## 更新与冲突

增量节点仍须提供完整核心字段 `id`、`label`、`type`；关系须提供完整核心字段。可选字段未出现时保留旧值；提供空字符串或空数组可以清空对应文本或标签。

同身份记录内容有变化时，默认不应用，进入冲突预览。可逐项选择，也可批量选择：

| 策略     | 行为                                                        |
| -------- | ----------------------------------------------------------- |
| 逐项确认 | 所有冲突明确处理后才允许确认                                |
| 保留当前 | 保留当前记录；不丢弃其他无冲突的新记录                      |
| 采用导入 | 应用导入方提供的字段                                        |
| 较新版本 | 同来源先比较双方都有的 revision，否则比较双方都有的更新时间 |

不同来源的 revision 不可比较。版本号相同，或时间相同、缺失时，不推断哪一条更正确，仍需逐项确认。来源元数据的“较新”使用 `exported_at`；扩展值没有可比较时间，仍需确认。

重复导入不是默认覆盖授权。页面仅在整个批次校验通过、冲突全部解决且用户确认后一次性替换内存图谱。取消、格式错误、超时和预览期间的内容修改均不写入工作区，也不自动保存本机缓存。

## 编程接口

`parseMgp(text, knownIds)` 解析 JSON 或 JSONL，返回图谱、提示和格式；失败时抛出带 `issues` 的 `MgpError`。`validateMgp` 可对对象执行同等运行时校验。

`planImport(base, incoming, {policy, choices})` 默认使用逐项确认，返回 `stats`、`conflicts`、`unresolved`、`warnings`、`canApply` 与候选 `graph`。它不修改输入；`canApply` 为 false 时不能把候选图谱当成已完成导入。页面还会核对工作区版本，在用户确认后才引用候选图谱。

`mergeMgp` 为旧代码保留默认采用导入字段的行为；新集成应先使用 `planImport` 的 review 流程，或明确传入冲突策略。`stringifyMgp(graph, "json" | "jsonl")` 可输出两种格式。

## 显式删除与旧数据回放

1.1 使用 `deleted` 表达删除，不根据缺失、过期或文字内容猜测删除操作：

```json
{
  "protocol": "mgp/1.1",
  "mode": "delta",
  "source": {
    "id": "notes:conversation:stable-key",
    "completeness": "partial"
  },
  "nodes": [],
  "edges": [],
  "deleted": {
    "nodes": [
      { "id": "notes:memory:stable-key", "deleted_at": "2026-01-02T10:00:00Z" }
    ],
    "edges": [
      {
        "id": "notes:relation:stable-key",
        "deleted_at": "2026-01-02T10:00:00Z"
      }
    ]
  }
}
```

没有关系 ID 时，删除记录须提供 `from`、`to`、`type`。删除记录可带 `source_id`、`source_ref`。删除现存记录也属于冲突，必须明确选择；删除节点会在预览中统计连带删除的关系。

删除墓碑保存在导出数据的 `deleted` 中，并记录来源。后续重放旧快照时，恢复节点或关系需要再次处理冲突。“较新”只在双方都有可比较时间时决定恢复，不能静默复活旧数据。关系的端点未被保留时，该关系不会被创建；预览会要求保留端点或明确不导入该关系。

同一批次不能对同一身份同时更新和删除。重复删除是幂等操作。墓碑同样受资源限制；本轮未加入墓碑压缩或自动过期。

## JSONL

第一条非空行是头记录。它包含 `kind: header`、协议、来源等元数据，不能内嵌 `nodes`、`edges`、`deleted`。之后每行一条记录，本体放在 `value`：

```jsonl
{"kind":"header","protocol":"mgp/1.1","mode":"snapshot","source":{"id":"notes:example","completeness":"partial"}}
{"kind":"node","value":{"id":"notes:one","label":"一条记忆","type":"memory"}}
{"kind":"node","value":{"id":"notes:two","label":"另一条记忆","type":"memory"}}
{"kind":"edge","value":{"from":"notes:one","to":"notes:two","type":"relates_to","basis":"explicit"}}
```

还支持 `delete_node`、`delete_edge`。空行和文件开头的 UTF-8 BOM 被忽略。允许只含 header 的空批次。每批只能有一个 header，整批通过校验后才应用；不做逐行部分写入。跨文件关系只能引用已存在工作区中的稳定 ID。

格式错误与语义错误返回字段路径、行号和列号；界面可点击定位。最多展示前 100 项错误。

## 资源与不可信输入

- 单批输入与合并后的紧凑 JSON 都不超过 12 MiB（UTF-8 字节数）。
- 每个工作区最多 50,000 个节点、250,000 条关系；墓碑数组分别受相同数量限制。
- 最多 1,000 个来源或单条记录的 1,000 条来源追溯，嵌套深度不超过 24。
- `__proto__`、`constructor`、`prototype` 属性名在任何层级都被拒绝；非有限数字、未知枚举和错误日期也被拒绝。
- 内容以纯文本处理；不会执行脚本、指令、Markdown 或导入的 URL。
- 校验与差异计算在可取消的 Worker 中完成，30 秒超时后不应用。JSONL 按完整文本读取，尚未实现流式导入。

资源上限是数据处理边界，不是 Canvas 布局的流畅性保证。大图渲染优化留在后续工作范围。
