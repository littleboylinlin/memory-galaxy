export function benchmarkGraph(count, links) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: "n:" + i,
    label: "m" + i,
    type: i % 3 ? "memory" : "topic",
    content: i % 47 ? "body" : "zephyr",
    tags: ["g" + (i % 7)],
  }));
  const edges = Array.from({ length: count * links }, (_, i) => {
    const from = Math.floor(i / links);
    return {
      from: nodes[from].id,
      to: nodes[(from + (i % links) + 1) % count].id,
      type: "link",
      basis: "explicit",
    };
  });
  return {
    protocol: "mgp/1.1",
    source: { id: "s", platform: "manual", completeness: "partial" },
    nodes,
    edges,
  };
}
