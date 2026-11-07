import { graphSources } from "./mgp.mjs";
import { GROUP_NAMES } from "./layout.mjs";
import {
  loadReviewRecords,
  saveReviewAction,
  clearReviewRecords,
} from "./review-state.mjs";
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const excerpt = (text = "", limit = 240) =>
  text.length > limit ? text.slice(0, limit) + "…" : text;
const kinds = {
  duplicates: [
    "疑似重复",
    "先对比稳定 ID、正文与来源。同名或相同正文不等于事实重复；此处不执行合并或删除。",
  ],
  isolated: [
    "孤立节点",
    "独立记忆可以保留。只有原文确有依据时，再在详情中手动建立关系。",
  ],
  sources: [
    "来源或追溯不完整",
    "核对原始记录，取得真实出处后再手动编辑或导入；不会自动补造来源。",
  ],
  stale: [
    "待核实的旧记录",
    "根据当前状态与更新时间筛选，不代表最后确认时间。请核对原文后自行决定是否编辑状态。",
  ],
};
export class InsightsUi {
  constructor(options) {
    Object.assign(this, options);
    this.active = null;
    this.sequence = 0;
    this.writes = 0;
    this.reviewPage = this.healthPage = 0;
    this.healthKind = "duplicates";
    $("refreshReview").onclick = () => this.run("review");
    $("runHealth").onclick = () => this.run("health");
    for (const id of ["reviewMode", "reviewAge"])
      $(id).onchange = () => {
        this.reviewPage = 0;
        this.onSessionChange();
        this.run("review");
      };
    $("healthAge").onchange = () => {
      this.healthPage = 0;
      this.onSessionChange();
      this.run("health");
    };
    for (const [id, kind, delta] of [
      ["reviewPrevious", "review", -1],
      ["reviewNext", "review", 1],
      ["healthPrevious", "health", -1],
      ["healthNext", "health", 1],
    ])
      $(id).onclick = () => {
        this[kind + "Page"] += delta;
        if (kind === "review") this.run(kind);
        else this.renderHealth();
        this.onSessionChange();
        $("panel-" + kind).scrollTop = 0;
      };
    $("clearReviews").onclick = () =>
      this.onConfirm(
        "清除本机回顾状态",
        "将清除本机资料中的全部收藏、跳过和已回顾记录，无法撤销。记忆、关系及已导出的备份仍会保留。",
        () => this.clear(),
      );
    try {
      this.channel = new BroadcastChannel("memory-galaxy-review-status");
      this.channel.onmessage = () => {
        if (this.active === "review" && !this.pending) this.run("review");
      };
    } catch {
      /* Cross-tab refresh remains available through the refresh button. */
    }
  }
  get pending() {
    return this.writes > 0;
  }
  tabState() {
    return {
      reviewMode: $("reviewMode").value,
      reviewAge: Number($("reviewAge").value),
      reviewPage: this.reviewPage,
      healthKind: this.healthKind,
      healthAge: Number($("healthAge").value),
      healthPage: this.healthPage,
    };
  }
  restoreTabState(state) {
    if (!state) return;
    $("reviewMode").value = state.reviewMode;
    $("reviewAge").value = String(state.reviewAge);
    $("healthAge").value = String(state.healthAge);
    this.reviewPage = state.reviewPage;
    this.healthPage = state.healthPage;
    this.healthKind = state.healthKind;
  }
  activate(view) {
    this.active = ["review", "health"].includes(view) ? view : null;
    this.cancel();
    if (this.active) this.run(this.active);
  }
  invalidate() {
    this.cancel();
    this.reviewPage = this.healthPage = 0;
    this.healthData = null;
    this.resultGraph = null;
    $("reviewCards").replaceChildren();
    $("healthResults").replaceChildren();
    $("healthCategories").replaceChildren();
    for (const kind of ["review", "health"]) {
      $(kind + "Summary").textContent =
        "工作区已变化，打开此页或点击刷新重新分析。";
      $(kind + "Pagination").hidden = true;
    }
  }
  filtersChanged() {
    if (this.active === "review") {
      this.reviewPage = 0;
      this.run("review");
    }
  }
  cancel() {
    this.sequence++;
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    for (const kind of ["review", "health"])
      $("panel-" + kind).setAttribute("aria-busy", "false");
  }
  status(text, error = false) {
    $("reviewStatus").textContent = text;
    $("reviewStatus").classList.toggle("error", error);
  }
  async run(kind) {
    this.cancel();
    const token = this.sequence,
      graph = this.getGraph();
    if (kind === "review" && this.isExample()) {
      $("reviewCards").replaceChildren();
      $("reviewSummary").textContent =
        "当前是示例星图。请先导入或添加自己的记忆，再保存个人回顾状态。";
      $("reviewPagination").hidden = true;
      return;
    }
    $("panel-" + kind).setAttribute("aria-busy", "true");
    $(kind + "Summary").textContent = "正在此设备上分析…";
    $(kind === "review" ? "reviewCards" : "healthResults").replaceChildren();
    $(kind + "Pagination").hidden = true;
    this.timer = setTimeout(() => {
      if (token !== this.sequence) return;
      this.cancel();
      $(kind + "Summary").textContent =
        "本地分析超时，请刷新此页重试。记忆未改变。";
    }, 30000);
    let reading = kind === "review";
    try {
      const records =
        kind === "review"
          ? await loadReviewRecords(graph.nodes.map((node) => node.id))
          : [];
      reading = false;
      if (token !== this.sequence || this.getGraph() !== graph) return;
      this.worker = new Worker(
        new URL("./insights-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this.worker.onerror = () => {
        if (token !== this.sequence) return;
        this.cancel();
        $(kind + "Summary").textContent =
          "无法启动本地分析，请点击刷新重试；原有浏览、编辑和保存仍可使用。";
      };
      this.worker.onmessage = ({ data }) => {
        if (
          token !== this.sequence ||
          data.id !== token ||
          this.getGraph() !== graph
        )
          return;
        this.cancel();
        if (!data.ok) {
          $(kind + "Summary").textContent = "本地分析失败：" + data.message;
          return;
        }
        this.resultGraph = graph;
        if (kind === "review") this.renderReview(data.result, graph);
        else {
          this.healthData = data.result;
          this.renderHealth();
        }
      };
      this.worker.postMessage({
        id: token,
        kind,
        graph,
        options:
          kind === "review"
            ? {
                records,
                now: Date.now(),
                minAgeDays: Number($("reviewAge").value),
                mode: $("reviewMode").value,
                page: this.reviewPage,
                filterIds: this.getFilteredIds(),
              }
            : { now: Date.now(), staleDays: Number($("healthAge").value) },
      });
    } catch (error) {
      if (token !== this.sequence) return;
      this.cancel();
      $(kind + "Summary").textContent = reading
        ? "无法读取回顾状态，已暂停回顾操作。原记录未覆盖，请点击刷新重试。"
        : "无法启动本地分析，请点击刷新重试；原有记忆未改变。";
      this.status(error.message, true);
    }
  }
  recordHeading(node) {
    const heading = el("div", undefined, "insight-record-heading");
    heading.append(
      el("h3", node.label),
      el("span", GROUP_NAMES[node.type] || node.type, "badge"),
    );
    return heading;
  }
  sourceText(node, graph) {
    const declaration = graphSources(graph).find(
      (source) => source.id === (node.source_id || graph.source.id),
    );
    const parts = [
      "来源声明：" +
        (node.source_id || graph.source.id) +
        (declaration?.platform ? " · " + declaration.platform : ""),
    ];
    if (node.source_ref) parts.push("出处：" + node.source_ref);
    for (const origin of node.provenance || [])
      parts.push(
        "追溯：" + origin.source_id + (origin.ref ? " · " + origin.ref : ""),
      );
    return parts.join("\n");
  }
  locateButton(id, text = "查看记忆详情") {
    const button = el("button", text, "btn");
    button.type = "button";
    button.onclick = () => this.onLocate(id, true);
    return button;
  }
  renderReview(result, graph) {
    this.reviewPage = result.page;
    $("reviewSummary").textContent =
      `${result.total.toLocaleString()} 条符合当前筛选 · 全工作区 ${result.missingTime} 条无可用更新时间、${result.futureTime} 条时间晚于本机时钟。`;
    $("reviewBasis").textContent = "本次本机计算基准：" + result.computedAt;
    const wrap = $("reviewCards"),
      nodes = new Map(graph.nodes.map((node) => [node.id, node])),
      edges = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
      edges.get(edge.from)?.push(edge);
      if (edge.to !== edge.from) edges.get(edge.to)?.push(edge);
    }
    wrap.replaceChildren();
    if (!result.items.length)
      wrap.append(
        el(
          "p",
          "没有符合条件的记忆。可以调整现有查找/类型/状态筛选，或切换到全部记忆、无时间记录；不会猜测日期。",
          "empty-state",
        ),
      );
    for (const item of result.items) {
      const node = nodes.get(item.id),
        card = el("article", undefined, "insight-card review-card");
      card.dataset.nodeId = node.id;
      card.append(
        this.recordHeading(node),
        el("p", "稳定 ID：" + node.id, "insight-id"),
        el("p", excerpt(node.content) || "未提供正文", "insight-body"),
        el("p", this.sourceText(node, graph), "insight-source"),
      );
      const reasons = el("ul", undefined, "review-reasons");
      for (const reason of item.reasons) reasons.append(el("li", reason));
      card.append(el("h4", "为何出现在这里"), reasons);
      const relations = edges.get(node.id);
      if (relations.length) {
        const details = el("details", undefined, "review-relations");
        details.append(el("summary", `已有关系（${relations.length} 条）`));
        const list = el("ul");
        for (const edge of relations.slice(0, 6)) {
          const otherId = edge.from === node.id ? edge.to : edge.from,
            other = nodes.get(otherId);
          if (!other) continue;
          const li = el("li");
          li.append(
            this.locateButton(
              otherId,
              (edge.from === node.id ? "→ " : "← ") + other.label,
            ),
            el(
              "p",
              `稳定 ID：${otherId}\n关系：${edge.type} · ${{ explicit: "明确（声明）", inferred: "推测（声明）", rule: "规则（声明）" }[edge.basis] || edge.basis}\n依据：${edge.evidence || "未提供"}\n${this.sourceText(edge, graph)}`,
            ),
          );
          list.append(li);
        }
        if (relations.length > 6)
          list.append(el("li", "其余关系可在记忆详情中分页查看。"));
        details.append(list);
        card.append(details);
      }
      const actions = el("div", undefined, "actions insight-actions");
      for (const [kind, text] of [
        ["favorite", item.favorite ? "取消收藏" : "收藏"],
        ["skip", "跳过7天"],
        ["reviewed", "已回顾"],
        ...(item.reviewedAt || item.skippedUntil
          ? [["reset", "重新待回顾"]]
          : []),
      ]) {
        const button = el("button", text, "btn review-action");
        button.type = "button";
        button.dataset.action = kind;
        if (kind === "favorite")
          button.setAttribute("aria-pressed", String(item.favorite));
        button.disabled = this.pending;
        button.onclick = () =>
          this.save(
            { id: item.id, kind, value: !item.favorite, version: item.version },
            graph,
          );
        actions.append(button);
      }
      actions.append(this.locateButton(node.id));
      card.append(actions);
      wrap.append(card);
    }
    this.pagination("review", result.page, result.pages);
    this.onSessionChange();
  }
  pagination(kind, page, pages) {
    $(kind + "Pagination").hidden = false;
    $(kind + "Page").textContent = `${page + 1} / ${pages}`;
    $(kind + "Previous").disabled = page <= 0;
    $(kind + "Next").disabled = page >= pages - 1;
  }
  renderHealth() {
    const result = this.healthData,
      graph = this.resultGraph;
    if (!result || graph !== this.getGraph()) return;
    $("healthSummary").textContent =
      `${this.isExample() ? "示例体检 · " : ""}检查 ${result.nodes.toLocaleString()} 条记忆、${result.edges.toLocaleString()} 条关系 · ${result.missingTime} 条缺少可用更新时间、${result.futureTime} 条时间晚于本机时钟（这些时间不用于判断长期）。`;
    $("healthBasis").textContent = "本次本机计算基准：" + result.computedAt;
    $("healthCategories").replaceChildren();
    for (const [key, [name]] of Object.entries(kinds)) {
      const button = el(
        "button",
        name +
          " · " +
          result[key].length +
          (key === "duplicates" ? " 组线索" : " 条"),
        "chip",
      );
      button.type = "button";
      button.dataset.category = key;
      button.setAttribute("aria-pressed", String(this.healthKind === key));
      button.onclick = () => {
        this.healthKind = key;
        this.healthPage = 0;
        this.renderHealth();
        this.onSessionChange();
      };
      $("healthCategories").append(button);
    }
    const records = result[this.healthKind],
      pages = Math.max(1, Math.ceil(records.length / 12)),
      nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    this.healthPage = Math.max(0, Math.min(this.healthPage, pages - 1));
    $("healthAdvice").textContent = kinds[this.healthKind][1];
    const wrap = $("healthResults");
    wrap.replaceChildren();
    if (!records.length)
      wrap.append(
        el(
          "p",
          "本项规则未发现线索，不代表所有记忆已被核实或完整。",
          "empty-state",
        ),
      );
    for (const finding of records.slice(
      this.healthPage * 12,
      this.healthPage * 12 + 12,
    )) {
      const card = el("article", undefined, "insight-card health-card");
      card.append(el("p", finding.reason));
      if (finding.ids) {
        const details = el("details", undefined, "duplicate-members");
        details.append(
          el(
            "summary",
            `核对本组 ${finding.ids.length} 条记忆（按稳定 ID 区分）`,
          ),
        );
        const members = el("div"),
          controls = el("div", undefined, "pagination"),
          previous = el("button", "上一组成员", "btn"),
          next = el("button", "下一组成员", "btn"),
          label = el("span");
        let memberPage = 0;
        const render = () => {
          members.replaceChildren();
          for (const id of finding.ids.slice(
            memberPage * 5,
            memberPage * 5 + 5,
          ))
            members.append(this.healthNode(nodes.get(id), graph));
          label.textContent = `${memberPage + 1} / ${Math.ceil(finding.ids.length / 5)}`;
          previous.disabled = memberPage === 0;
          next.disabled = (memberPage + 1) * 5 >= finding.ids.length;
        };
        previous.onclick = () => {
          memberPage--;
          render();
        };
        next.onclick = () => {
          memberPage++;
          render();
        };
        previous.type = next.type = "button";
        controls.append(previous, label, next);
        details.append(members, controls);
        details.ontoggle = () => {
          if (details.open && !members.childNodes.length) render();
        };
        card.append(details);
      } else card.append(this.healthNode(nodes.get(finding.id), graph));
      wrap.append(card);
    }
    this.pagination("health", this.healthPage, pages);
    this.onSessionChange();
  }
  healthNode(node, graph) {
    const item = el("div", undefined, "health-node");
    item.dataset.nodeId = node.id;
    item.append(
      this.recordHeading(node),
      el("p", "稳定 ID：" + node.id, "insight-id"),
      el("p", excerpt(node.content) || "未提供正文", "insight-body"),
      el("p", this.sourceText(node, graph), "insight-source"),
      this.locateButton(node.id, "查看并核对"),
    );
    return item;
  }
  updatePending() {
    $("clearReviews").disabled = this.pending;
    for (const button of $("reviewCards").querySelectorAll(".review-action"))
      button.disabled = this.pending;
  }
  async save(action, graph) {
    if (this.pending) return;
    if (graph !== this.getGraph()) {
      this.status("记忆已变化，请刷新回顾后再操作。", true);
      return;
    }
    this.writes++;
    this.updatePending();
    this.status("正在保存回顾状态…");
    try {
      await saveReviewAction(action);
      this.status(
        (globalThis.memoryGalaxyDesktop
          ? "回顾状态已写入本地资料库。"
          : "回顾状态已保存到此浏览器。") +
          (this.hasPendingWorkspace()
            ? "记忆内容仍有未保存修改，请另行保存到本机。"
            : "记忆内容没有被修改。"),
      );
      this.channel?.postMessage({ changed: true });
    } catch (error) {
      this.status(
        "回顾状态保存失败，操作未应用，请重试：" + error.message,
        true,
      );
    } finally {
      this.writes--;
      this.updatePending();
      if (this.active === "review") this.run("review");
    }
  }
  async clear() {
    if (this.pending) return;
    this.writes++;
    this.updatePending();
    this.status("正在清除回顾状态…");
    try {
      await clearReviewRecords();
      this.status("本机回顾状态已清除。记忆和原有工作区备份未改变。");
      this.channel?.postMessage({ changed: true });
    } catch (error) {
      this.status("清除失败，原回顾记录仍保留：" + error.message, true);
    } finally {
      this.writes--;
      this.updatePending();
      if (this.active === "review") this.run("review");
    }
  }
}
