const shortId = (id) =>
  id.length > 25 ? id.slice(0, 10) + "…" + id.slice(-10) : id;

export function findNodes(nodes, text, limit = 35) {
  const query = text.trim().toLocaleLowerCase();
  const matches = nodes.filter((node) =>
    [node.label, node.id].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
  const ids = new Map();
  for (const node of matches) {
    const short = shortId(node.id);
    ids.set(short, (ids.get(short) || 0) + 1);
  }
  return {
    total: matches.length,
    nodes: matches.slice(0, limit).map((node) => ({
      ...node,
      shortId: ids.get(shortId(node.id)) > 1 ? node.id : shortId(node.id),
    })),
  };
}

export class NodePicker {
  constructor(id, { getNodes, typeName, onChange }) {
    this.input = document.getElementById(id);
    this.results = document.getElementById(id + "Results");
    this.hint = document.getElementById(id + "Hint");
    Object.assign(this, { getNodes, typeName, onChange });
    this.input.oninput = () => {
      this.id = null;
      this.input.removeAttribute("data-node-id");
      this.hint.textContent = "请从搜索结果中选择记忆。";
      this.render();
      this.onChange();
    };
    this.input.onfocus = () => this.render();
    this.input.onkeydown = (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.render();
        this.results.querySelector("button")?.focus();
      } else if (event.key === "Escape" && !this.results.hidden) {
        event.preventDefault();
        event.stopPropagation();
        this.results.hidden = true;
        this.input.setAttribute("aria-expanded", "false");
      }
    };
    this.input.parentElement.addEventListener("focusout", (event) => {
      if (!this.input.parentElement.contains(event.relatedTarget)) this.hide();
    });
  }
  hide() {
    this.results.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
  }
  set(id) {
    const node = this.getNodes().find((node) => node.id === id);
    this.id = node?.id ?? null;
    this.input.value = node?.label || "";
    if (node) this.input.dataset.nodeId = node.id;
    else this.input.removeAttribute("data-node-id");
    this.hint.textContent = node
      ? `${this.typeName(node.type)} · ${node.id}`
      : "输入标题后，从搜索结果中选择。";
    this.hide();
  }
  render() {
    const { nodes, total } = findNodes(
      this.getNodes(),
      this.id ? "" : this.input.value,
    );
    this.results.replaceChildren();
    const summary = document.createElement("li");
    summary.className = "small muted";
    summary.textContent = total
      ? `找到 ${total.toLocaleString()} 条，显示前 ${nodes.length} 条；可继续输入缩小范围。`
      : "没有匹配的现有记忆。";
    this.results.append(summary);
    for (const node of nodes) {
      const item = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.textContent = `${node.label} · ${this.typeName(node.type)} · ${node.shortId}`;
      button.title = node.id;
      button.dataset.nodeId = node.id;
      button.onclick = () => {
        this.set(node.id);
        this.onChange();
        this.input.focus();
        this.hide();
      };
      button.onkeydown = (event) => {
        const buttons = [...this.results.querySelectorAll("button")],
          index = buttons.indexOf(button);
        if (["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Escape") {
            event.stopPropagation();
            this.input.focus();
            this.hide();
          } else
            buttons[
              (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                buttons.length
            ]?.focus();
        }
      };
      item.append(button);
      this.results.append(item);
    }
    this.results.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
  }
}
