import { emptyGraph, graphSources, LIMITS } from "./mgp.mjs";
import { ImportClient } from "./import-client.mjs";
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const labels = {
  node: "节点更新",
  edge: "关系更新",
  "delete-node": "删除节点",
  "delete-edge": "删除关系",
  "restore-node": "恢复已删除节点",
  "restore-edge": "恢复已删除关系",
  "edge-dependency": "关系端点未保留",
  source: "来源声明",
  extension: "扩展数据",
};
const coverage = {
  full: "全量（仅导出方声明，未经验证）",
  partial: "部分",
  unknown: "未知",
};
const PAGE_SIZE = 30;
const EDITOR_SIZE = 64 * 1024;
export class ImportUi {
  #client = new ImportClient();
  #request = 0;
  #fileRequest = 0;
  #plan;
  #parsed;
  #choices = {};
  #baseRevision;
  #page = 0;
  #largeText = null;
  constructor({ getGraph, getRevision, isExample, onApply, onNotice }) {
    Object.assign(this, {
      getGraph,
      getRevision,
      isExample,
      onApply,
      onNotice,
    });
    $("importBtn").textContent = "预览导入";
    $("importBtn").onclick = () => this.open($("input").value, "粘贴内容");
    $("chooseFile").onclick = () => $("fileInput").click();
    $("fileInput").accept =
      ".json,.jsonl,.ndjson,application/json,application/x-ndjson";
    $("fileInput").onchange = (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) this.openFile(file);
    };
    $("analyzeImport").onclick = () => this.analyze();
    $("applyImport").onclick = () => this.apply();
    $("cancelImport").onclick = () => this.close();
    $("closeImport").onclick = () => this.close();
    $("importDialog").addEventListener("cancel", () => this.cancelSession());
    $("importDialog").addEventListener("close", () => {
      if (!$("importDialog").open) this.cancelSession();
    });
    $("importText").addEventListener("input", () => {
      this.#largeText = null;
      this.#fileRequest++;
      this.#request++;
      this.#client.cancel();
      this.#choices = {};
      this.#page = 0;
      this.#plan = undefined;
      this.clearPreview();
      this.status("内容已修改，点击「重新校验」更新预览。");
    });
    for (const input of [$("input"), $("importText")])
      input.addEventListener("paste", (event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text && (text.length > EDITOR_SIZE || input.readOnly)) {
          event.preventDefault();
          this.open(text, "粘贴内容");
        }
      });
    $("conflictPolicy").onchange = () => {
      this.#choices = {};
      this.#page = 0;
      this.analyze();
    };
    $("conflictPrevious").onclick = () => {
      this.#page--;
      this.renderConflicts();
    };
    $("conflictNext").onclick = () => {
      this.#page++;
      this.renderConflicts();
    };
    const drop = $("drop");
    document.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        drop.classList.add("active");
      }
    });
    document.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget) drop.classList.remove("active");
    });
    document.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      drop.classList.remove("active");
      if (event.dataTransfer.files.length !== 1) {
        this.onNotice("请每次导入一个文件，完成确认后再导入下一批。", true);
        return;
      }
      this.openFile(event.dataTransfer.files[0]);
    });
  }
  status(message, error = false) {
    $("importStatus").textContent = message;
    $("importStatus").classList.toggle("error", error);
  }
  clearPreview() {
    $("applyImport").disabled = true;
    $("importPreview").hidden = true;
    $("importErrors").replaceChildren();
    $("importErrors").hidden = true;
    $("analyzeImport").disabled = false;
    $("importDialog").setAttribute("aria-busy", "false");
  }
  show() {
    if (!$("importDialog").open) $("importDialog").showModal();
  }
  cancelSession() {
    this.#request++;
    this.#fileRequest++;
    this.#client.cancel();
    this.#plan = undefined;
    this.#parsed = undefined;
    this.#largeText = null;
  }
  close() {
    this.cancelSession();
    $("importDialog").close();
  }
  open(text, label) {
    this.#fileRequest++;
    this.show();
    $("importOrigin").textContent = label;
    if (text.length > LIMITS.bytes) {
      this.#request++;
      this.#client.cancel();
      this.#plan = undefined;
      this.loadText("");
      this.clearPreview();
      this.status("内容超过 12 MiB，请拆分为多个批次。", true);
      return;
    }
    this.loadText(text);
    this.#choices = {};
    this.#page = 0;
    $("conflictPolicy").value = "review";
    this.analyze();
  }
  loadText(text) {
    this.#largeText = text.length > EDITOR_SIZE ? text : null;
    $("importText").readOnly = this.#largeText !== null;
    $("importText").value = text.slice(0, EDITOR_SIZE);
    $("importTextHint").hidden = this.#largeText === null;
    $("importTextHint").textContent =
      "大批次仅展示前 65,536 个字符，完整原文会参与校验和导入。点击错误可查看对应片段；修改请重新粘贴或选择修正后的文件。";
  }
  async openFile(file) {
    const request = ++this.#fileRequest;
    this.show();
    this.#request++;
    this.#client.cancel();
    this.#plan = undefined;
    this.clearPreview();
    $("importOrigin").textContent = file.name;
    this.loadText("");
    if (file.size > LIMITS.bytes) {
      this.status("文件超过 12 MiB，请拆分为多个批次。", true);
      return;
    }
    this.status("正在读取文件…");
    try {
      const text = await file.text();
      if (request !== this.#fileRequest || !$("importDialog").open) return;
      this.open(text, file.name);
    } catch {
      if (request === this.#fileRequest && $("importDialog").open)
        this.status("文件读取失败，请重新选择。", true);
    }
  }
  async analyze() {
    const request = ++this.#request,
      text = this.#largeText ?? $("importText").value;
    this.#client.cancel();
    this.#plan = undefined;
    this.clearPreview();
    $("analyzeImport").disabled = true;
    $("importDialog").setAttribute("aria-busy", "true");
    this.status("正在校验与计算差异…");
    const revision = this.getRevision(),
      demo = this.isExample();
    try {
      const result = await this.#client.preview(
        text,
        demo ? emptyGraph() : this.getGraph(),
        { policy: $("conflictPolicy").value, choices: this.#choices },
      );
      if (request !== this.#request) return;
      if (revision !== this.getRevision()) {
        this.clearPreview();
        this.status("当前图谱已变化，请重新校验。", true);
        return;
      }
      this.#baseRevision = revision;
      this.#plan = result.plan;
      this.#parsed = result.parsed;
      $("importDialog").setAttribute("aria-busy", "false");
      $("analyzeImport").disabled = false;
      this.render(demo);
    } catch (error) {
      if (request !== this.#request || error.name === "AbortError") return;
      this.clearPreview();
      this.status("未修改当前图谱。请修正以下错误后重新校验。", true);
      const list = $("importErrors");
      list.hidden = false;
      for (const issue of error.issues || [
        { path: "$", message: error.message },
      ]) {
        const item = el("li"),
          button = el(
            "button",
            (issue.line
              ? "第 " + issue.line + " 行，第 " + (issue.column || 1) + " 列 · "
              : "") +
              issue.path +
              ": " +
              issue.message,
            "issue-location",
          );
        button.type = "button";
        button.onclick = () => {
          const input = $("importText");
          input.focus();
          if (issue.line) {
            const source = this.#largeText ?? input.value;
            const lines = source.replace(/^\uFEFF/, "").split("\n");
            const offset =
              lines
                .slice(0, issue.line - 1)
                .reduce((sum, line) => sum + line.length + 1, 0) +
              (issue.column || 1) -
              1 +
              (source.startsWith("\uFEFF") ? 1 : 0);
            const start = this.#largeText ? Math.max(0, offset - 2000) : 0;
            if (this.#largeText) {
              input.value = source.slice(start, start + EDITOR_SIZE);
              $("importTextHint").textContent =
                `原文第 ${start + 1}～${Math.min(source.length, start + EDITOR_SIZE)} 个字符（共 ${source.length}）。错误行列对应完整原文；请重新粘贴或选择修正后的文件以修改。`;
            }
            input.setSelectionRange(offset - start, offset - start + 1);
          }
        };
        item.append(button);
        list.append(item);
      }
      if ((error.issues?.length || 0) >= LIMITS.issues)
        list.append(
          el("li", "已显示前 " + LIMITS.issues + " 项错误。修正后请重新校验。"),
        );
    }
  }
  render(demo) {
    const { stats, conflicts, unresolved, warnings, canApply, graph } =
      this.#plan;
    $("importPreview").hidden = false;
    $("applyImport").disabled = !canApply;
    $("previewFormat").textContent =
      (this.#parsed.format === "jsonl" ? "JSONL" : "JSON") +
      " · " +
      this.#parsed.graph.protocol +
      " → " +
      graph.protocol;
    $("previewDemo").hidden = !demo;
    const summary = $("previewSummary");
    summary.replaceChildren();
    for (const [label, value] of [
      ["新增节点", stats.addedNodes],
      ["更新节点", stats.updatedNodes],
      ["删除节点", stats.deletedNodes],
      ["新增关系", stats.addedEdges],
      ["更新关系", stats.updatedEdges],
      ["删除关系", stats.deletedEdges],
    ]) {
      const item = el("div", undefined, "preview-stat");
      item.append(el("strong", value.toLocaleString()), el("span", label));
      summary.append(item);
    }
    $("previewTotals").textContent =
      "确认后共 " +
      graph.nodes.length.toLocaleString() +
      " 个节点、" +
      graph.edges.length.toLocaleString() +
      " 条关系；" +
      stats.unchanged.toLocaleString() +
      " 条记录保持不变。";
    const sources = $("previewSources");
    sources.replaceChildren();
    for (const source of graphSources(this.#parsed.graph)) {
      const item = el("li");
      item.append(
        el("strong", source.id),
        el(
          "span",
          " · " +
            (source.platform || "未声明平台") +
            " · 覆盖：" +
            coverage[source.completeness || "unknown"],
        ),
      );
      if (source.scope) item.append(el("p", source.scope, "muted"));
      sources.append(item);
    }
    const notice = $("previewWarnings");
    notice.replaceChildren();
    notice.hidden = !warnings.length;
    for (const message of warnings.slice(0, 100))
      notice.append(el("li", message));
    if (warnings.length > 100)
      notice.append(
        el(
          "li",
          "另有 " +
            (warnings.length - 100) +
            " 条提示。全部数据均已校验；请核对完整批次。",
        ),
      );
    this.renderRecords();
    this.renderConflicts();
    this.status(
      unresolved
        ? "还有 " +
            unresolved.toLocaleString() +
            " 项冲突待处理。当前图谱保持不变。"
        : "校验通过。请核对预览后确认导入。",
    );
    $("conflictSection").hidden = !conflicts.length;
  }
  renderRecords() {
    const { nodes, edges, deleted } = this.#parsed.graph,
      list = $("previewRecords");
    list.replaceChildren();
    const total =
      nodes.length +
      edges.length +
      (deleted?.nodes?.length || 0) +
      (deleted?.edges?.length || 0);
    $("recordCount").textContent =
      "查看本批记录（" + total.toLocaleString() + "）";
    const records = [
      ...nodes.slice(0, 30).map((n) => ({
        title: n.label,
        body: n.id + " · " + n.type + (n.content ? "\n" + n.content : ""),
      })),
      ...edges.slice(0, 30).map((e) => ({
        title: e.from + " → " + e.to,
        body: e.type + " · " + e.basis + (e.evidence ? "\n" + e.evidence : ""),
      })),
      ...(deleted?.nodes || [])
        .slice(0, 10)
        .map((d) => ({ title: "删除节点：" + d.id, body: d.deleted_at })),
      ...(deleted?.edges || []).slice(0, 10).map((d) => ({
        title: "删除关系：" + (d.id || d.from + " → " + d.to + " · " + d.type),
        body: d.deleted_at,
      })),
    ];
    for (const record of records) {
      const item = el("li", undefined, "preview-record");
      item.append(
        el("strong", record.title),
        el("p", record.body.slice(0, 600)),
      );
      list.append(item);
    }
    if (records.length < total)
      list.append(
        el(
          "li",
          "此处展示部分记录；左侧文本包含完整批次。全部记录均已校验。",
          "muted",
        ),
      );
  }
  renderConflicts() {
    if (!this.#plan) return;
    const { conflicts, unresolved } = this.#plan,
      wrap = $("previewConflicts");
    wrap.replaceChildren();
    const pages = Math.max(1, Math.ceil(conflicts.length / PAGE_SIZE));
    this.#page = Math.max(0, Math.min(this.#page, pages - 1));
    $("conflictCount").textContent =
      "冲突 " +
      conflicts.length.toLocaleString() +
      " 项 · 待处理 " +
      unresolved.toLocaleString() +
      " 项";
    $("conflictPage").textContent = this.#page + 1 + " / " + pages;
    $("conflictPrevious").disabled = this.#page === 0;
    $("conflictNext").disabled = this.#page === pages - 1;
    for (const conflict of conflicts.slice(
      this.#page * PAGE_SIZE,
      (this.#page + 1) * PAGE_SIZE,
    )) {
      const card = el("article", undefined, "conflict-card");
      card.append(el("h4", labels[conflict.kind] + " · " + conflict.id));
      const comparison = el("div", undefined, "conflict-comparison");
      for (const [label, value] of [
        ["当前记录", conflict.existing],
        ["导入记录", conflict.incoming],
      ]) {
        const column = el("details"),
          heading = el("summary", label),
          pre = el("pre", JSON.stringify(value, null, 2));
        column.append(heading, pre);
        comparison.append(column);
      }
      card.append(comparison);
      const label = el("label", "处理方式"),
        select = el("select");
      select.setAttribute("aria-label", "处理冲突 " + conflict.id);
      for (const [value, title] of [
        ["review", "请选择"],
        [
          "keep",
          conflict.kind === "edge-dependency" ? "不导入该关系" : "保留当前",
        ],
        ["incoming", "采用导入"],
      ]) {
        const option = el("option", title);
        option.value = value;
        select.append(option);
      }
      select.value = conflict.resolution || "review";
      select.onchange = () => {
        this.#choices[conflict.key] = select.value;
        this.analyze();
      };
      label.append(select);
      card.append(label);
      wrap.append(card);
    }
  }
  apply() {
    if (!this.#plan?.canApply) return;
    if (this.#baseRevision !== this.getRevision()) {
      this.#plan = undefined;
      this.clearPreview();
      this.status("当前图谱已变化，请重新校验。", true);
      return;
    }
    const { graph, stats } = this.#plan;
    this.onApply(graph);
    $("input").value = "";
    $("importText").value = "";
    this.close();
    this.onNotice(
      "导入完成：新增 " +
        stats.addedNodes +
        " 个节点、更新 " +
        stats.updatedNodes +
        " 个节点、删除 " +
        stats.deletedNodes +
        " 个节点。当前共 " +
        graph.nodes.length +
        " 个节点、" +
        graph.edges.length +
        " 条关系；如需下次恢复，请点击「保存到本机」。",
    );
  }
}
