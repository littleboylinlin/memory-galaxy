import { createLayout, layoutPositions, hash } from "./layout.mjs";
import { edgeKey } from "./mgp.mjs";
export const PALETTE = {
  memory: "#a8b4ff",
  person: "#f3aed7",
  project: "#eac78a",
  topic: "#85d1fa",
  event: "#f6a4b5",
  preference: "#fac59b",
  goal: "#ceb1fa",
  skill: "#81decb",
  other: "#bdcce2",
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export class Sky {
  constructor(
    canvas,
    {
      onSelect = () => {},
      onMove = () => {},
      onStatus = () => {},
      onZoom = () => {},
    } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onSelect = onSelect;
    this.onMove = onMove;
    this.onStatus = onStatus;
    this.onZoom = onZoom;
    this.nodes = [];
    this.edges = [];
    this.positions = new Float32Array();
    this.indices = new Map();
    this.pins = new Set();
    this.filter = new Uint8Array();
    this.groups = [];
    this.selected = null;
    this.highlight = null;
    this.neighbors = new Set();
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.points = new Map();
    this.generation = 0;
    this.animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.showLabels = true;
    this.clusterBy = "type";
    this.active = false;
    this.cameraTouched = false;
    this.pendingFrame = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bind();
    try {
      this.worker = new Worker(
        new URL("./layout-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (event) => this.receive(event.data);
      this.worker.onerror = () => {
        this.worker.terminate();
        this.worker = null;
        this.active = false;
        this.onStatus({
          error: "后台布局不可用，保留当前位置；仍可搜索、拖动和编辑。",
        });
        this.invalidate();
      };
    } catch {
      this.worker = null;
    }
  }
  setGraph(graph, view = {}) {
    this.generation++;
    this.nodes = graph.nodes;
    this.edges = graph.edges;
    this.indices = new Map(this.nodes.map((node, index) => [node.id, index]));
    this.edgeIndices = this.edges.map((edge) => [
      this.indices.get(edge.from),
      this.indices.get(edge.to),
    ]);
    this.adjacency = Array.from(this.nodes, () => []);
    this.edges.forEach((edge, index) => {
      const [a, b] = this.edgeIndices[index];
      if (a !== undefined && b !== undefined) {
        this.adjacency[a].push(index);
        if (a !== b) this.adjacency[b].push(index);
      }
    });
    this.clusterBy = view.clusterBy || this.clusterBy;
    this.showLabels = view.showLabels ?? this.showLabels;
    this.animate = view.animate ?? this.animate;
    this.pins = new Set(
      (view.positions || [])
        .filter((position) => position.pinned)
        .map((position) => position.id),
    );
    const nodes = this.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        source_id: node.source_id || graph.source.id,
      })),
      edges = this.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    const options = {
      clusterBy: this.clusterBy,
      positions: view.positions || [],
    };
    const initial = createLayout(nodes, edges, options);
    this.positions = layoutPositions(initial);
    this.groups = initial.groups;
    this.assignments = initial.assignments;
    this.filter = new Uint8Array(nodes.length).fill(1);
    this.setSelection(this.indices.has(this.selected) ? this.selected : null);
    this.cameraTouched = false;
    this.fit(true);
    if (this.worker) {
      this.active = true;
      this.worker.postMessage({
        type: "start",
        generation: this.generation,
        nodes,
        edges,
        options,
      });
    } else {
      this.active = false;
      this.onStatus({
        error:
          "此浏览器不支持后台布局，显示初始星图；可使用记忆列表浏览全部数据。",
      });
    }
    this.invalidate();
  }
  receive(data) {
    if (data.generation !== this.generation) return;
    if (data.type === "groups") {
      this.groups = data.groups;
      this.assignments = data.assignments;
      return;
    }
    if (data.type !== "positions") return;
    this.active = data.active;
    if (this.animate || !data.active) {
      const dragging = this.gesture?.node;
      if (dragging !== undefined) {
        const index = this.indices.get(dragging);
        if (index !== undefined) {
          data.positions[index * 2] = this.positions[index * 2];
          data.positions[index * 2 + 1] = this.positions[index * 2 + 1];
        }
      }
      this.positions = data.positions;
      if (!data.active && !this.cameraTouched) this.fit(true);
      this.invalidate();
    }
    this.onStatus({ active: this.active, iteration: data.iteration });
  }
  setFilter(ids) {
    this.filter = Uint8Array.from(this.nodes, (node) =>
      ids.has(node.id) ? 1 : 0,
    );
    this.invalidate();
  }
  setSelection(id, edge = null) {
    this.selected = id;
    this.highlight = edge;
    this.neighbors = new Set();
    const index = this.indices.get(id);
    if (index !== undefined) {
      this.neighbors.add(index);
      for (const edgeIndex of this.adjacency[index] || []) {
        const [a, b] = this.edgeIndices[edgeIndex];
        this.neighbors.add(a);
        this.neighbors.add(b);
      }
    }
    this.invalidate();
  }
  setLabels(value) {
    this.showLabels = value;
    this.invalidate();
  }
  setAnimate(value) {
    this.animate = value;
    this.invalidate();
  }
  getPositions() {
    return this.nodes.map((node, index) => ({
      id: node.id,
      x: this.positions[index * 2],
      y: this.positions[index * 2 + 1],
      pinned: this.pins.has(node.id),
    }));
  }
  setPinned(id, pinned) {
    const index = this.indices.get(id);
    if (index === undefined) return;
    if (pinned) this.pins.add(id);
    else this.pins.delete(id);
    this.worker?.postMessage({
      type: "pin",
      generation: this.generation,
      id,
      x: this.positions[index * 2],
      y: this.positions[index * 2 + 1],
      pinned,
    });
    this.onMove({ id, pinned });
    this.invalidate();
  }
  resize() {
    const ratio = Math.min(2, devicePixelRatio || 1),
      width = Math.max(1, this.canvas.clientWidth),
      height = Math.max(1, this.canvas.clientHeight);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.invalidate();
  }
  invalidate() {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.draw();
    });
  }
  world(x, y) {
    return {
      x: (x - this.canvas.clientWidth / 2 - this.pan.x) / this.zoom,
      y: (y - this.canvas.clientHeight / 2 - this.pan.y) / this.zoom,
    };
  }
  screen(index) {
    return {
      x:
        this.positions[index * 2] * this.zoom +
        this.canvas.clientWidth / 2 +
        this.pan.x,
      y:
        this.positions[index * 2 + 1] * this.zoom +
        this.canvas.clientHeight / 2 +
        this.pan.y,
    };
  }
  fit(automatic = false) {
    if (!automatic) this.cameraTouched = true;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.filter[i]) continue;
      const x = this.positions[i * 2],
        y = this.positions[i * 2 + 1];
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (!Number.isFinite(left)) {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
    } else {
      this.zoom = clamp(
        Math.min(
          (this.canvas.clientWidth - 100) / Math.max(160, right - left),
          (this.canvas.clientHeight - 170) / Math.max(160, bottom - top),
        ),
        0.000001,
        2,
      );
      this.pan = {
        x: (-(left + right) / 2) * this.zoom,
        y: (-(top + bottom) / 2) * this.zoom,
      };
    }
    this.onZoom(this.zoom);
    this.invalidate();
  }
  focus(id) {
    this.cameraTouched = true;
    const index = this.indices.get(id);
    if (index === undefined) return;
    this.zoom = clamp(Math.max(this.zoom, 1.1), 0.000001, 3);
    this.pan = {
      x: -this.positions[index * 2] * this.zoom,
      y: -this.positions[index * 2 + 1] * this.zoom,
    };
    this.onZoom(this.zoom);
    this.invalidate();
  }
  scale(
    factor,
    x = this.canvas.clientWidth / 2,
    y = this.canvas.clientHeight / 2,
  ) {
    this.cameraTouched = true;
    const world = this.world(x, y);
    this.zoom = clamp(this.zoom * factor, 0.000001, 6);
    this.pan = {
      x: x - this.canvas.clientWidth / 2 - world.x * this.zoom,
      y: y - this.canvas.clientHeight / 2 - world.y * this.zoom,
    };
    this.onZoom(this.zoom);
    this.invalidate();
  }
  hit(x, y) {
    const cell = 28,
      cx = Math.floor(x / cell),
      cy = Math.floor(y / cell);
    let best = null,
      distance = 18;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const index of this.hitGrid?.get(cx + dx + "," + (cy + dy)) ||
          []) {
          const position = this.screen(index),
            next = Math.hypot(x - position.x, y - position.y);
          if (next < distance) {
            best = this.nodes[index].id;
            distance = next;
          }
        }
    return best;
  }
  draw() {
    const { ctx, canvas } = this,
      width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    for (let i = 0; i < 85; i++) {
      ctx.fillStyle = i % 3 ? "#7791ba" : "#d7e5ff";
      ctx.globalAlpha = 0.15 + (hash("opacity" + i) % 30) / 100;
      ctx.fillRect(
        ((hash("x" + i) % 10000) / 10000) * width,
        ((hash("y" + i) % 10000) / 10000) * height,
        i % 5 === 0 ? 1.5 : 1,
        1,
      );
    }
    ctx.globalAlpha = 1;
    const coordinates = new Float32Array(this.nodes.length * 2),
      inside = new Uint8Array(this.nodes.length),
      visible = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.filter[i]) continue;
      const point = this.screen(i);
      coordinates[i * 2] = point.x;
      coordinates[i * 2 + 1] = point.y;
      if (
        point.x >= -25 &&
        point.x <= width + 25 &&
        point.y >= -25 &&
        point.y <= height + 25
      ) {
        inside[i] = 1;
        visible.push(i);
      }
    }
    let edgeCount = 0;
    const edgeBudget = 12000,
      selectedEdges = this.indices.has(this.selected)
        ? new Set(this.adjacency[this.indices.get(this.selected)])
        : new Set();
    const drawEdge = (index) => {
      const edge = this.edges[index],
        [a, b] = this.edgeIndices[index];
      if (!this.filter[a] || !this.filter[b]) return false;
      if (!inside[a] && !inside[b]) {
        const ax = coordinates[a * 2],
          ay = coordinates[a * 2 + 1],
          bx = coordinates[b * 2],
          by = coordinates[b * 2 + 1];
        if (
          Math.max(ax, bx) < 0 ||
          Math.min(ax, bx) > width ||
          Math.max(ay, by) < 0 ||
          Math.min(ay, by) > height
        )
          return false;
      }
      const related = selectedEdges.has(index),
        highlight = this.highlight === edgeKey(edge);
      ctx.globalAlpha = highlight
        ? 0.95
        : related
          ? 0.8
          : this.selected
            ? 0.07
            : 0.2;
      ctx.strokeStyle = highlight
        ? "#f1dc9c"
        : related
          ? "#b4bfff"
          : edge.basis === "inferred"
            ? "#c19bf0"
            : "#8ba8cf";
      ctx.lineWidth = highlight ? 2.5 : related ? 1.4 : 0.8;
      ctx.setLineDash(edge.basis === "inferred" ? [4, 5] : []);
      ctx.beginPath();
      ctx.moveTo(coordinates[a * 2], coordinates[a * 2 + 1]);
      ctx.lineTo(coordinates[b * 2], coordinates[b * 2 + 1]);
      ctx.stroke();
      return true;
    };
    for (
      let index = 0;
      index < this.edges.length && edgeCount < edgeBudget;
      index++
    ) {
      if (selectedEdges.has(index)) continue;
      if (drawEdge(index)) edgeCount++;
    }
    let relatedCount = 0;
    for (const index of selectedEdges) {
      if (relatedCount >= 3000) break;
      if (drawEdge(index)) {
        relatedCount++;
        edgeCount++;
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (
      this.showLabels &&
      this.groups.length > 1 &&
      this.groups.length <= 20 &&
      this.zoom > 0.12
    ) {
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#b4a8e1";
      const centers = this.groups.map(() => ({
        x: 0,
        top: Infinity,
        count: 0,
      }));
      for (let index = 0; index < this.nodes.length; index++) {
        if (!this.filter[index]) continue;
        const center = centers[this.assignments[index]];
        center.x += coordinates[index * 2];
        center.top = Math.min(center.top, coordinates[index * 2 + 1]);
        center.count++;
      }
      for (let index = 0; index < this.groups.length; index++) {
        const group = this.groups[index],
          center = centers[index];
        if (!center.count) continue;
        const x = center.x / center.count,
          y = center.top - 26;
        ctx.globalAlpha = 0.6;
        ctx.fillText(group.label.slice(0, 30) + " · " + center.count, x, y);
      }
    }
    const buckets = new Set();
    this.hitGrid = new Map();
    let drawn = 0,
      labels = 0;
    const dense = visible.length > 3000;
    const ordered = this.selected
      ? [
          ...visible.filter((index) => this.neighbors.has(index)),
          ...visible.filter((index) => !this.neighbors.has(index)),
        ]
      : visible;
    for (const index of ordered) {
      const node = this.nodes[index],
        x = coordinates[index * 2],
        y = coordinates[index * 2 + 1],
        selected = node.id === this.selected,
        related = this.neighbors.has(index),
        bucket = Math.floor(x / 7) + "," + Math.floor(y / 7);
      if (drawn >= 8000 && !selected) continue;
      if (dense && buckets.has(bucket) && !related) continue;
      buckets.add(bucket);
      drawn++;
      const key = Math.floor(x / 28) + "," + Math.floor(y / 28);
      if (!this.hitGrid.has(key)) this.hitGrid.set(key, []);
      this.hitGrid.get(key).push(index);
      const radius = selected
        ? 6.5
        : clamp(2.5 + Math.sqrt(this.adjacency[index].length) * 0.35, 2.5, 6);
      ctx.globalAlpha =
        (node.state === "deprecated" ? 0.38 : 1) *
        (this.selected && !related ? 0.28 : 1);
      ctx.fillStyle = PALETTE[node.type] || PALETTE.other;
      if (selected) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y, 17, 0, Math.PI * 2);
        ctx.fillStyle = "#a99dff26";
        ctx.fill();
        ctx.strokeStyle = "#d3c8ff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = PALETTE[node.type] || PALETTE.other;
      }
      if (!dense) {
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = selected ? 20 : 8;
      }
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (this.pins.has(node.id)) {
        ctx.strokeStyle = "#e6ddff";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 2, y - 2, 4, 4);
      }
      if (
        this.showLabels &&
        (selected ||
          ((related || visible.length < 100 || this.zoom > 1.8) &&
            labels < 110))
      ) {
        ctx.globalAlpha = selected ? 1 : 0.86;
        ctx.font = (selected ? "600 " : "") + "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#e3e7fa";
        ctx.fillText(
          node.label.length > 23 ? node.label.slice(0, 22) + "…" : node.label,
          x,
          y + radius + 15,
        );
        labels++;
      }
    }
    ctx.globalAlpha = 1;
    this.onStatus({
      drawn,
      inViewport: visible.length,
      edgesDrawn: edgeCount,
      totalEdges: this.edges.length,
      filtered: this.filter.reduce((sum, value) => sum + value, 0),
      active: this.active,
      aggregated: drawn < visible.length || this.edges.length > edgeCount,
    });
  }
  bind() {
    const { canvas } = this;
    const local = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      const point = local(event);
      this.cameraTouched = true;
      this.points.set(event.pointerId, point);
      canvas.setPointerCapture(event.pointerId);
      if (this.points.size === 2) {
        const [a, b] = [...this.points.values()],
          mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.gesture = {
          pinch: true,
          distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          zoom: this.zoom,
          world: this.world(mid.x, mid.y),
        };
      } else if (this.points.size === 1)
        this.gesture = {
          start: point,
          pan: { ...this.pan },
          node: this.hit(point.x, point.y) ?? undefined,
          moved: false,
        };
      canvas.classList.add("grabbing");
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.points.has(event.pointerId) || !this.gesture) return;
      const point = local(event);
      this.points.set(event.pointerId, point);
      if (this.gesture.pinch) {
        if (this.points.size !== 2) return;
        const [a, b] = [...this.points.values()],
          mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.zoom = clamp(
          (this.gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
            this.gesture.distance,
          0.000001,
          6,
        );
        this.pan = {
          x: mid.x - canvas.clientWidth / 2 - this.gesture.world.x * this.zoom,
          y: mid.y - canvas.clientHeight / 2 - this.gesture.world.y * this.zoom,
        };
        this.onZoom(this.zoom);
        this.invalidate();
        return;
      }
      const gesture = this.gesture;
      gesture.moved ||=
        Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 5;
      if (!gesture.moved) return;
      if (gesture.node !== undefined) {
        const index = this.indices.get(gesture.node),
          raw = this.world(point.x, point.y),
          position = { x: clamp(raw.x, -1e7, 1e7), y: clamp(raw.y, -1e7, 1e7) };
        this.positions[index * 2] = position.x;
        this.positions[index * 2 + 1] = position.y;
        this.pins.add(gesture.node);
        this.worker?.postMessage({
          type: "pin",
          generation: this.generation,
          id: gesture.node,
          ...position,
          pinned: true,
        });
      } else
        this.pan = {
          x: gesture.pan.x + point.x - gesture.start.x,
          y: gesture.pan.y + point.y - gesture.start.y,
        };
      this.invalidate();
    });
    const finish = (event, cancelled = false) => {
      if (!this.points.has(event.pointerId)) return;
      const gesture = this.gesture;
      this.points.delete(event.pointerId);
      if (gesture && !gesture.pinch) {
        if (gesture.moved && gesture.node !== undefined)
          this.onMove({ id: gesture.node, pinned: true });
        else if (!gesture.moved && !cancelled)
          this.onSelect(gesture.node ?? null);
      }
      this.gesture = null;
      if (!this.points.size) canvas.classList.remove("grabbing");
    };
    canvas.addEventListener("pointerup", (event) => finish(event));
    canvas.addEventListener("pointercancel", (event) => finish(event, true));
    canvas.addEventListener("lostpointercapture", (event) =>
      finish(event, true),
    );
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const point = local(event);
        this.scale(
          Math.exp(-clamp(event.deltaY, -300, 300) * 0.002),
          point.x,
          point.y,
        );
      },
      { passive: false },
    );
    canvas.addEventListener("dblclick", () => this.fit());
    canvas.addEventListener("keydown", (event) => {
      let handled = true;
      const amount = event.shiftKey ? 150 : 60;
      if (event.key === "ArrowLeft") this.pan.x += amount;
      else if (event.key === "ArrowRight") this.pan.x -= amount;
      else if (event.key === "ArrowUp") this.pan.y += amount;
      else if (event.key === "ArrowDown") this.pan.y -= amount;
      else if (["+", "="].includes(event.key)) this.scale(1.25);
      else if (event.key === "-") this.scale(0.8);
      else if (event.key === "Home") this.fit();
      else if (event.key === "Escape") this.onSelect(null);
      else handled = false;
      if (handled) {
        this.cameraTouched = true;
        event.preventDefault();
        this.invalidate();
      }
    });
  }
}
