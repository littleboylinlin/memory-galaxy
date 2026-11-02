export const GROUP_NAMES = {
  memory: "记忆",
  person: "人物",
  project: "项目",
  topic: "主题",
  event: "事件",
  preference: "偏好",
  goal: "目标",
  skill: "技能",
  other: "其他",
};
export function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
const random = (text) => hash(text) / 4294967296;
export function clusterGraph(nodes, edges, by = "type") {
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const parent = Int32Array.from(nodes, (_, i) => i),
    rank = new Uint8Array(nodes.length);
  const root = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  if (by === "component")
    for (const edge of edges) {
      const a = indices.get(edge.from),
        b = indices.get(edge.to);
      if (a === undefined || b === undefined) continue;
      let x = root(a),
        y = root(b);
      if (x === y) continue;
      if (rank[x] < rank[y]) [x, y] = [y, x];
      parent[y] = x;
      if (rank[x] === rank[y]) rank[x]++;
    }
  const componentNames = new Map();
  if (by === "component")
    nodes.forEach((node, index) => {
      const key = root(index),
        old = componentNames.get(key);
      if (old === undefined || node.id < old) componentNames.set(key, node.id);
    });
  const keys = nodes.map((node, index) =>
    by === "component"
      ? componentNames.get(root(index))
      : by === "source"
        ? node.source_id || node.provenance?.[0]?.source_id || "未知来源"
        : by === "none"
          ? "全部"
          : node.type,
  );
  const groups = [...new Set(keys)].sort().map((key) => ({
    key,
    label:
      by === "type"
        ? GROUP_NAMES[key] || key
        : by === "component"
          ? "连通星团"
          : key,
    count: 0,
    x: 0,
    y: 0,
  }));
  const groupIndex = new Map(groups.map((group, index) => [group.key, index]));
  const assignments = Uint32Array.from(keys, (key) => groupIndex.get(key));
  for (const index of assignments) groups[index].count++;
  groups.forEach((group, index) => {
    if (groups.length === 1) return;
    const angle = index * 2.399963229728653;
    const radius =
      groups.length <= 12
        ? Math.sqrt(nodes.length) * 28 + 100
        : Math.sqrt(index + 1) * 105;
    group.x = Math.cos(angle) * radius;
    group.y = Math.sin(angle) * radius;
  });
  return { groups, assignments, indices };
}
export function createLayout(
  nodes,
  edges,
  { clusterBy = "type", positions = [] } = {},
) {
  const { groups, assignments, indices } = clusterGraph(
      nodes,
      edges,
      clusterBy,
    ),
    n = nodes.length;
  const x = new Float64Array(n),
    y = new Float64Array(n),
    vx = new Float64Array(n),
    vy = new Float64Array(n),
    pinned = new Uint8Array(n),
    degree = new Uint32Array(n);
  const previous = new Map(
    positions.map((position) => [position.id, position]),
  );
  nodes.forEach((node, index) => {
    const saved = previous.get(node.id),
      group = groups[assignments[index]],
      angle = random(node.id + ":angle") * Math.PI * 2,
      radius =
        Math.sqrt(random(node.id + ":radius")) *
        Math.max(55, Math.sqrt(group.count) * 22);
    x[index] = saved?.x ?? group.x + Math.cos(angle) * radius;
    y[index] = saved?.y ?? group.y + Math.sin(angle) * radius;
    pinned[index] = saved?.pinned ? 1 : 0;
  });
  const pairs = [];
  for (const edge of edges) {
    const a = indices.get(edge.from),
      b = indices.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    pairs.push(a, b);
    degree[a]++;
    degree[b]++;
  }
  return {
    nodes,
    groups,
    assignments,
    indices,
    x,
    y,
    vx,
    vy,
    pinned,
    degree,
    pairs: Uint32Array.from(pairs),
    iteration: 0,
    energy: Infinity,
  };
}
export function stepLayout(state, iterations = 1) {
  const { x, y, vx, vy, pinned, degree, pairs, groups, assignments } = state,
    n = x.length,
    cellSize = 100;
  for (let step = 0; step < iterations; step++) {
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const key =
        Math.floor(x[i] / cellSize) + "," + Math.floor(y[i] / cellSize);
      let cell = grid.get(key);
      if (!cell) {
        cell = { x: 0, y: 0, count: 0 };
        grid.set(key, cell);
      }
      cell.x += x[i];
      cell.y += y[i];
      cell.count++;
    }
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        vx[i] = vy[i] = 0;
        continue;
      }
      const cx = Math.floor(x[i] / cellSize),
        cy = Math.floor(y[i] / cellSize);
      let fx = 0,
        fy = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(cx + dx + "," + (cy + dy));
          if (!cell) continue;
          const own = dx === 0 && dy === 0 ? 1 : 0,
            count = cell.count - own;
          if (!count) continue;
          let ox = x[i] - (cell.x - own * x[i]) / count,
            oy = y[i] - (cell.y - own * y[i]) / count;
          if (Math.abs(ox) + Math.abs(oy) < 0.01) {
            const angle = random(state.nodes[i].id) * Math.PI * 2;
            ox = Math.cos(angle);
            oy = Math.sin(angle);
          }
          const distance = ox * ox + oy * oy + 80,
            force = Math.min(4, (220 * count) / distance);
          fx += ox * force;
          fy += oy * force;
        }
      const group = groups[assignments[i]],
        gravity = groups.length > 1 ? 0.0022 : 0.0007;
      fx += (group.x - x[i]) * gravity;
      fy += (group.y - y[i]) * gravity;
      vx[i] = (vx[i] + Math.max(-4, Math.min(4, fx))) * 0.78;
      vy[i] = (vy[i] + Math.max(-4, Math.min(4, fy))) * 0.78;
    }
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i],
        b = pairs[i + 1],
        dx = x[b] - x[a],
        dy = y[b] - y[a],
        distance = Math.hypot(dx, dy) || 1,
        force = Math.max(-2, Math.min(2, (distance - 95) * 0.009)),
        fx = (dx / distance) * force,
        fy = (dy / distance) * force;
      if (!pinned[a]) {
        vx[a] += fx / Math.sqrt(degree[a] || 1);
        vy[a] += fy / Math.sqrt(degree[a] || 1);
      }
      if (!pinned[b]) {
        vx[b] -= fx / Math.sqrt(degree[b] || 1);
        vy[b] -= fy / Math.sqrt(degree[b] || 1);
      }
    }
    let energy = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const dx = Math.max(-7, Math.min(7, vx[i])),
        dy = Math.max(-7, Math.min(7, vy[i]));
      x[i] += dx;
      y[i] += dy;
      energy += dx * dx + dy * dy;
    }
    state.energy = n ? energy / n : 0;
    state.iteration++;
  }
  return state.energy;
}
export function pinNode(state, id, x, y, pinned = true) {
  const index = state.indices.get(id);
  if (index === undefined || !Number.isFinite(x) || !Number.isFinite(y))
    return false;
  state.x[index] = x;
  state.y[index] = y;
  state.vx[index] = state.vy[index] = 0;
  state.pinned[index] = pinned ? 1 : 0;
  return true;
}
export function layoutPositions(state) {
  const values = new Float32Array(state.x.length * 2);
  for (let i = 0; i < state.x.length; i++) {
    values[i * 2] = state.x[i];
    values[i * 2 + 1] = state.y[i];
  }
  return values;
}
