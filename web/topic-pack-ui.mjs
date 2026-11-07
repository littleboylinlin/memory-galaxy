import { NODE_TYPES, NODE_STATES, edgeKey } from "./mgp.mjs";
import { GROUP_NAMES } from "./layout.mjs";
import { NodePicker } from "./node-picker.mjs";
import {
  emptyPackConfig,
  packConfig,
  packPayload,
  packMarkdown,
  packRecords,
} from "./topic-packs.mjs";
import { listPacks, loadPack, writePack } from "./topic-pack-store.mjs";
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const stateNames = {
  confirmed: "已确认",
  inferred: "推测",
  disputed: "有争议",
  deprecated: "已过时",
  unknown: "未知",
};
const fields = [
  "packTitle",
  "packKeyword",
  "packTag",
  "packType",
  "packState",
  "packRelated",
];
const kindNames = { nodes: "记忆", edges: "关系", sources: "来源声明" },
  changesNames = { added: "新增", modified: "修改", removed: "移出" };
export class TopicPackUi {
  constructor(options) {
    Object.assign(this, options);
    this.config = emptyPackConfig();
    this.savedSignature = JSON.stringify(this.config);
    this.sequence = 0;
    this.writes = 0;
    this.id = null;
    this.revision = 0;
    this.baseline = null;
    this.page = 0;
    for (const [id, values, names] of [
      ["packType", NODE_TYPES, GROUP_NAMES],
      ["packState", NODE_STATES, stateNames],
    ])
      for (const value of values) {
        const option = el("option", names[value] || value);
        option.value = value;
        $(id).append(option);
      }
    for (const id of fields)
      $(id).addEventListener(
        id === "packType" || id === "packState" || id === "packRelated"
          ? "change"
          : "input",
        () => {
          this.readFields();
          this.changed();
        },
      );
    this.picker = new NodePicker("packAddNode", {
      getNodes: () => this.getGraph().nodes,
      typeName: (type) => GROUP_NAMES[type] || type,
      onChange: () => {
        $("packAdd").disabled = !this.picker.id || this.busy;
      },
    });
    $("packAdd").onclick = () => {
      const id = this.picker.id;
      if (!id || this.busy) return;
      this.config.includeIds = [...new Set([...this.config.includeIds, id])];
      this.config.excludeIds = this.config.excludeIds.filter(
        (value) => value !== id,
      );
      this.picker.set(null);
      this.changed();
      this.preview();
    };
    $("packCopyFilters").onclick = () => {
      const filters = this.getFilters();
      Object.assign(this.config.rules, filters);
      this.fillFields();
      this.changed();
    };
    $("packPreview").onclick = () => this.preview();
    $("packSave").onclick = () => {
      if (this.busy) return;
      this.onConfirm(
        "保存配置与本次基线",
        "将当前预览设为下一次比较基线，当前差异随后归零。如需本次增量，请先导出再保存。仅保存配置与指纹，不修改原始记忆。",
        () => this.save(),
      );
    };
    $("packLoad").onclick = () => {
      const id = $("packSaved").value;
      if (id) this.guard(() => this.load(id));
    };
    $("packNew").onclick = () => this.guard(() => this.newPack());
    $("packDelete").onclick = () => {
      if (!this.id || this.busy) return;
      this.onConfirm(
        "删除主题包配置",
        "仅删除这个主题包配置与指纹基线，无法撤销；原始记忆、关系和工作区备份不会改变。" +
          (this.dirty ? "本页未保存的配置修改也会丢弃。" : ""),
        () => this.remove(),
      );
    };
    $("packRefreshList").onclick = () => this.directory();
    $("packKind").onchange = () => {
      this.page = 0;
      this.render();
    };
    $("packPrevious").onclick = () => {
      this.page--;
      this.render();
    };
    $("packNext").onclick = () => {
      this.page++;
      this.render();
    };
    for (const [id, format] of [
      ["packJson", "json"],
      ["packMarkdown", "md"],
    ])
      $(id).onclick = () => this.export(format);
    $("packOutputMode").onchange = () => this.render();
    try {
      this.channel = new BroadcastChannel("memory-galaxy-topic-packs");
      this.channel.onmessage = () => {
        this.status(
          "其他页面更新了主题包目录。当前草稿保留；保存使用版本校验，更新前请重新载入核对。",
        );
        this.directory();
      };
    } catch {
      /* Version checks inside the storage transaction remain authoritative. */
    }
    this.controls();
  }
  get dirty() {
    return JSON.stringify(this.config) !== this.savedSignature;
  }
  get pending() {
    return this.writes > 0;
  }
  get busy() {
    return this.pending || this.loading || !!this.worker;
  }
  tabState() {
    const id = this.id || this.restoreId;
    return id ? { id } : null;
  }
  restoreTabState(value) {
    this.restoreId = value?.id || null;
  }
  activate(view) {
    this.active = view === "packs";
    if (!this.active) {
      this.cancel();
      return;
    }
    this.tags();
    this.directory();
    if (this.restoreId && !this.dirty) {
      const id = this.restoreId;
      this.restoreId = null;
      this.load(id);
    }
  }
  readFields() {
    this.config.title = $("packTitle").value;
    this.config.rules = {
      keyword: $("packKeyword").value,
      tag: $("packTag").value,
      type: $("packType").value,
      state: $("packState").value,
      related: Number($("packRelated").value),
    };
  }
  fillFields() {
    const c = this.config;
    $("packTitle").value = c.title;
    for (const [id, key] of [
      ["packKeyword", "keyword"],
      ["packTag", "tag"],
      ["packType", "type"],
      ["packState", "state"],
      ["packRelated", "related"],
    ])
      $(id).value = String(c.rules[key]);
  }
  tags() {
    const tags = [
      ...new Set(this.getGraph().nodes.flatMap((node) => node.tags || [])),
    ];
    $("packTagOptions").replaceChildren(
      ...tags.slice(0, 100).map((tag) => {
        const option = el("option");
        option.value = tag;
        return option;
      }),
    );
    $("packTagHint").textContent =
      `完整标签匹配（区分大小写）。当前 ${tags.length} 种；提供前 ${Math.min(tags.length, 100)} 种建议，也可输入其他完整标签。`;
  }
  status(message, error = false) {
    $("packStatus").textContent = message;
    $("packStatus").classList.toggle("error", error);
  }
  controls() {
    const ready =
      this.result &&
      this.resultGraph === this.getGraph() &&
      this.resultConfig === JSON.stringify(this.config) &&
      !this.busy;
    for (const id of ["packSave", "packJson", "packMarkdown"])
      $(id).disabled = !ready || !this.config.title.trim();
    $("packDelete").disabled = !this.id || this.busy;
    for (const id of [
      ...fields,
      "packPreview",
      "packLoad",
      "packNew",
      "packSaved",
      "packCopyFilters",
      "packAddNode",
      "packRefreshList",
    ])
      $(id).disabled = !!this.busy;
    $("packAdd").disabled = !this.picker?.id || this.busy;
    for (const b of $("packResults").querySelectorAll(".pack-remove"))
      b.disabled = !!this.busy;
    $("packDraft").textContent = this.pending
      ? "正在写入主题包配置…"
      : this.dirty
        ? "配置有未保存修改"
        : this.id
          ? "已载入本机配置 · 基线只在主动保存时更新"
          : "新主题包 · 尚未保存配置";
  }
  cancel() {
    this.sequence++;
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    $("panel-packs").setAttribute("aria-busy", "false");
    this.controls();
  }
  invalidate(message = "工作区已变化，请重新预览；此前配置与基线未改变。") {
    this.cancel();
    this.result = null;
    this.resultGraph = null;
    $("packResults").replaceChildren();
    $("packPagination").hidden = true;
    $("packSummary").textContent = message;
    $("packDiffSummary").textContent = "";
    this.controls();
  }
  changed() {
    this.invalidate("配置已修改，请重新预览。");
    this.status("配置已修改，请预览并核对后再保存或导出。");
    this.onSessionChange();
  }
  guard(action) {
    if (this.busy) return;
    if (this.dirty)
      this.onConfirm(
        "放弃主题包草稿？",
        "当前主题包配置有未保存修改。继续会丢弃这些配置修改；原始记忆不变。",
        action,
      );
    else action();
  }
  newPack() {
    this.cancel();
    this.config = emptyPackConfig();
    this.savedSignature = JSON.stringify(this.config);
    this.id = null;
    this.revision = 0;
    this.baseline = null;
    this.fillFields();
    this.picker.set(null);
    this.invalidate();
    $("packSaved").value = "";
    this.status("已打开新主题包。原始记忆未改变。");
    this.onSessionChange();
  }
  async directory() {
    const token = (this.directoryToken = (this.directoryToken || 0) + 1);
    try {
      const rows = await listPacks();
      if (token !== this.directoryToken) return;
      const selected = $("packSaved").value || this.id || "";
      $("packSaved").replaceChildren(el("option", "选择已保存的配置"));
      $("packSaved").firstElementChild.value = "";
      for (const row of rows) {
        const option = el("option", row.title + " · " + row.id.slice(-8));
        option.value = row.id;
        $("packSaved").append(option);
      }
      $("packSaved").value = rows.some((row) => row.id === selected)
        ? selected
        : "";
    } catch (error) {
      this.status("主题包目录读取失败，未覆盖原记录：" + error.message, true);
    }
  }
  async load(id) {
    if (this.busy) return;
    this.loading = true;
    this.controls();
    try {
      const record = await loadPack(id);
      if (!record) throw new Error("该配置已不存在，请刷新目录。");
      this.config = record.config;
      this.id = record.id;
      $("packSaved").value = record.id;
      this.revision = record.revision;
      this.baseline = record.baseline;
      this.savedSignature = JSON.stringify(this.config);
      this.fillFields();
      this.picker.set(null);
      this.invalidate();
      this.status(
        "已载入本机配置与上次确认基线。点击预览以查看当前差异；不会自动更新基线。",
      );
      this.onSessionChange();
    } catch (error) {
      this.status("配置载入失败，当前草稿保留：" + error.message, true);
    } finally {
      this.loading = false;
      this.controls();
    }
  }
  preview() {
    if (this.busy) return;
    this.readFields();
    this.cancel();
    this.result = null;
    this.resultGraph = null;
    const graph = this.getGraph(),
      configuration = JSON.stringify(this.config),
      token = this.sequence;
    $("packResults").replaceChildren();
    $("packSummary").textContent = "正在本机筛选并计算指纹…";
    $("packPagination").hidden = true;
    $("panel-packs").setAttribute("aria-busy", "true");
    try {
      packConfig(this.config);
      this.worker = new Worker(
        new URL("./topic-pack-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this.controls();
      const fail = (message) => {
        if (token !== this.sequence) return;
        this.cancel();
        this.status(message, true);
        $("packSummary").textContent =
          "未生成可导出的预览，原始数据与已保存配置未改变。";
      };
      this.worker.onerror = () => fail("无法启动主题包本地分析，请重试。");
      this.timer = setTimeout(
        () => fail("主题包本地分析超时，请缩小范围后重试。"),
        30000,
      );
      this.worker.onmessage = ({ data }) => {
        if (
          token !== this.sequence ||
          data.id !== token ||
          graph !== this.getGraph() ||
          configuration !== JSON.stringify(this.config)
        )
          return;
        this.cancel();
        if (!data.ok) {
          $("packSummary").textContent =
            "分析失败，未生成可导出的预览；原数据未变。";
          this.status("主题包分析失败：" + data.message, true);
          return;
        }
        this.result = data.result;
        this.resultGraph = graph;
        this.resultConfig = configuration;
        this.page = 0;
        $("packEditor").open = false;
        this.render();
        this.controls();
        this.status(
          "预览已生成，尚未保存配置或下载文件。" +
            (this.hasPendingWorkspace()
              ? "当前工作区含未保存修改，导出使用页面当前内容。"
              : ""),
        );
      };
      this.worker.postMessage({
        id: token,
        graph,
        config: this.config,
        baseline: this.baseline,
      });
    } catch (error) {
      this.cancel();
      this.status("无法预览主题包：" + error.message, true);
    }
  }
  raw(record) {
    const details = el("details", undefined, "pack-raw");
    details.append(el("summary", "完整原记录"));
    details.ontoggle = () => {
      if (details.open && details.childElementCount === 1)
        details.append(el("pre", JSON.stringify(record, null, 2)));
    };
    return details;
  }
  nodeCard(node, reason) {
    const card = el("article", undefined, "insight-card pack-node");
    card.dataset.nodeId = node.id;
    card.append(
      this.recordUi.healthNode(node, this.resultGraph),
      el(
        "p",
        "确认状态：" +
          (node.state
            ? stateNames[node.state] + "（原声明：" + node.state + "）"
            : "原记录未提供，未补写"),
        "insight-note",
      ),
    );
    if (reason) card.append(el("p", reason, "insight-note"));
    card.append(this.raw(node));
    const remove = el("button", "从主题包移除", "btn pack-remove");
    remove.onclick = () => {
      this.config.includeIds = this.config.includeIds.filter(
        (id) => id !== node.id,
      );
      this.config.excludeIds = [
        ...new Set([...this.config.excludeIds, node.id]),
      ];
      this.changed();
      this.preview();
    };
    card.append(remove);
    return card;
  }
  render() {
    const r = this.result;
    if (!r || this.resultGraph !== this.getGraph()) return;
    const s = r.selection;
    $("packDeltaOption").disabled = !r.hasBaseline;
    if (!r.hasBaseline) $("packOutputMode").value = "full";
    const mode = $("packOutputMode").value,
      scope = packRecords(r, mode),
      checks = r.checks[mode];
    $("packSummary").textContent =
      `${this.isExample() ? "示例数据 · " : ""}主题选中 ${s.nodes.length.toLocaleString()} 条；本次${mode === "delta" ? "增量" : "完整"}导出 ${scope.nodes.length.toLocaleString()} 条记忆（端点上下文 ${scope.contextIds.length} 条）、${scope.edges.length.toLocaleString()} 条关系、${scope.sources.length} 条来源声明。${s.boundary.length} 条跨包关系及 ${s.invalid.length} 条失效关系不导出；${s.missingIds.length} 个手动加入 ID 已不在当前图谱。`;
    $("packDiffSummary").textContent =
      (r.hasBaseline
        ? "相对于上次主动保存的基线："
        : "尚无基线，所选记录均视为新增：") +
      Object.entries(r.changes)
        .map(
          ([kind, d]) =>
            `${kindNames[kind]} 新增 ${d.added.length} / 修改 ${d.modified.length} / 移出 ${d.removed.length}`,
        )
        .join("；") +
      `。本次导出的来源线索 ${checks.missingSources.length} 条，敏感线索 ${checks.sensitive.length} 项。`;
    $("packOutputHint").textContent =
      mode === "delta"
        ? "增量导出仅含新增／修改记录、移出 ID 与变化关系的未变端点上下文；需要接收方已有对应完整基线。保存基线不等于已导出。"
        : "完整导出包含上方全部所选记录及包内关系。保存配置不会自动下载；导出也不自动更新基线。";
    const wrap = $("packResults");
    wrap.replaceChildren();
    const kind = $("packKind").value,
      rows = [];
    if (kind === "nodes") {
      const reasons = new Map(s.reasons.map((row) => [row.id, row]));
      for (const node of scope.nodes) {
        const why = reasons.get(node.id);
        rows.push(() =>
          this.nodeCard(
            node,
            scope.contextIds.includes(node.id)
              ? "增量包中变化关系所需的未变端点上下文，非新增记忆。"
              : why.kind === "related"
                ? `已有关系扩展 ${why.depth} 层；来自 ID ${why.from}，经 ${why.via}。`
                : why.kind === "manual"
                  ? "你手动加入的稳定 ID。"
                  : "符合关键词、完整标签、类型及状态筛选。",
          ),
        );
      }
    }
    if (kind === "edges" || kind === "boundary")
      for (const edge of kind === "edges"
        ? s.edges
        : [...s.boundary, ...s.invalid])
        rows.push(() => {
          const card = el("article", undefined, "insight-card pack-edge");
          card.append(
            el("h3", edge.from + " → " + edge.to),
            el(
              "p",
              `关系键：${edgeKey(edge)} · 类型：${edge.type} · 依据类别：${edge.basis}（原声明）`,
            ),
            el("p", edge.evidence || "原记录未提供依据文字", "insight-body"),
            el(
              "p",
              this.recordUi.sourceText(edge, this.resultGraph),
              "insight-source",
            ),
            el(
              "p",
              kind === "edges"
                ? "将导出完整原记录。"
                : "不导出：至少一个端点不在包内。可按标题手动加入端点后重新核对。",
              "insight-note",
            ),
            this.raw(edge),
          );
          return card;
        });
    if (kind === "changes")
      for (const [k, d] of Object.entries(r.changes))
        for (const [change, list] of Object.entries(d))
          for (const id of list)
            rows.push(() => {
              const card = el("article", undefined, "insight-card");
              card.append(
                el("h3", kindNames[k] + " · " + changesNames[change]),
                el("p", id, "insight-id"),
              );
              const record = (
                k === "nodes"
                  ? s.nodes
                  : k === "edges"
                    ? s.edges
                    : [s.source, ...s.sources]
              ).find(
                (value) => (k === "edges" ? edgeKey(value) : value.id) === id,
              );
              if (record) card.append(this.raw(record));
              else
                card.append(
                  el("p", "仅记录移出 ID；本机基线不存旧正文，未编造旧值。"),
                );
              return card;
            });
    if (kind === "warnings") {
      for (const item of checks.missingSources)
        rows.push(() => this.warning(item.kind, item.id, item.reason));
      for (const item of checks.sensitive)
        rows.push(() =>
          this.warning(
            item.kind,
            item.id,
            item.hints
              .map(
                (hint) =>
                  hint.reason + "（字段：" + hint.fields.join("、") + "）",
              )
              .join("；"),
          ),
        );
      for (const id of s.missingIds)
        rows.push(() =>
          this.warning(
            "manual",
            id,
            "此手动加入 ID 不在当前图谱，本次不导出；配置中仍保留它。",
          ),
        );
      rows.push(() => {
        const card = el("article", undefined, "insight-card");
        card.append(
          el("h3", "将导出的完整来源声明"),
          this.raw({ source: s.source, declarations: scope.sources }),
        );
        return card;
      });
    }
    const pages = Math.max(1, Math.ceil(rows.length / 12));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    for (const row of rows.slice(this.page * 12, this.page * 12 + 12))
      wrap.append(row());
    if (!rows.length)
      wrap.append(
        el(
          "p",
          "本项没有记录；未发现敏感线索不代表可以安全公开，请自行核对。",
          "insight-note",
        ),
      );
    $("packPagination").hidden = false;
    $("packPage").textContent =
      `${this.page + 1} / ${pages} · ${rows.length.toLocaleString()} 项`;
    $("packPrevious").disabled = this.page === 0;
    $("packNext").disabled = this.page >= pages - 1;
    this.controls();
  }
  warning(kind, id, text) {
    const card = el("article", undefined, "insight-card");
    card.append(el("h3", kind + " · " + id), el("p", text, "insight-note"));
    return card;
  }
  current() {
    if (
      !this.result ||
      this.resultGraph !== this.getGraph() ||
      this.resultConfig !== JSON.stringify(this.config)
    )
      throw new Error("预览已过期，请重新预览并核对。");
    return this.result;
  }
  async save() {
    if (this.busy) return;
    let r;
    try {
      r = this.current();
      if (!this.config.title.trim()) throw new Error("请填写主题包名称");
    } catch (error) {
      this.status(error.message, true);
      return;
    }
    this.writes++;
    this.controls();
    this.status("正在写入主题包配置与指纹基线…");
    try {
      const record = await writePack({
        id: this.id || crypto.randomUUID(),
        config: this.config,
        baseline: r.baseline,
        expectedRevision: this.revision,
      });
      this.id = record.id;
      this.revision = record.revision;
      this.baseline = record.baseline;
      this.savedSignature = JSON.stringify(record.config);
      this.invalidate("基线已更新，请重新预览；将从已保存的基线继续比较。");
      this.channel?.postMessage({ changed: true });
      this.status(
        "主题包配置与本次指纹基线已保存到本机。当前差异基线已更新，请重新预览再导出。原始记忆和原有备份未改变；保存不代表已下载或交给其他服务。",
      );
      this.onSessionChange();
      await this.directory();
    } catch (error) {
      this.status("主题包保存失败，草稿与原配置保留：" + error.message, true);
    } finally {
      this.writes--;
      this.controls();
    }
  }
  async remove() {
    if (this.busy || !this.id) return;
    this.writes++;
    this.controls();
    try {
      await writePack({
        id: this.id,
        expectedRevision: this.revision,
        remove: true,
      });
      this.newPack();
      this.status("主题包配置已删除，原始记忆未改变。");
      this.channel?.postMessage({ changed: true });
      await this.directory();
    } catch (error) {
      this.status("删除失败，原配置保留：" + error.message, true);
    } finally {
      this.writes--;
      this.controls();
    }
  }
  export(format) {
    if (this.busy) return;
    let r;
    try {
      r = this.current();
    } catch (error) {
      this.status(error.message, true);
      return;
    }
    const mode = $("packOutputMode").value,
      config = JSON.stringify(this.config),
      graph = this.getGraph(),
      scope = packRecords(r, mode),
      checks = r.checks[mode];
    this.onConfirm(
      "确认手动导出主题包",
      `${scope.nodes.length} 条记忆（含 ${scope.contextIds.length} 条端点上下文）、${scope.edges.length} 条包内关系；${r.selection.boundary.length + r.selection.invalid.length} 条关系不导出。来源不完整线索 ${checks.missingSources.length} 条，敏感线索 ${checks.sensitive.length} 项。规则可能误报或漏报，请在预览中核对原文、元数据及来源。${mode === "delta" ? "本次是增量包：请确认接收方已有对应完整基线；移出不代表删除原数据。" : "本次是完整主题包。"}主题包以明文保存。继续仅发起本机文件下载，不会上传或发送给任何 AI。`,
      () => {
        try {
          if (
            graph !== this.getGraph() ||
            config !== JSON.stringify(this.config) ||
            r !== this.current() ||
            mode !== $("packOutputMode").value
          )
            throw new Error("预览已变化，请重新核对后导出。");
          const payload = packPayload(r, this.config.title, mode);
          this.onDownload(
            format === "json" ? payload : packMarkdown(payload),
            `memory-galaxy-topic-pack${mode === "delta" ? "-delta" : ""}.${format}`,
            format === "json"
              ? "application/json"
              : "text/markdown;charset=utf-8",
          );
          this.status(
            "已发起文件下载，请确认浏览器实际保存完成。未自动更新配置基线，未上传或发送数据。",
          );
        } catch (error) {
          this.status("无法导出：" + error.message, true);
        }
      },
    );
  }
}
