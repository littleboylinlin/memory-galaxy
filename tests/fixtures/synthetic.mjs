// Generated solely from counters; no account exports or personal records.
export function syntheticGraph() {
  const sources = [
    {
      id: "synthetic:notebook",
      platform: "notion",
      scope: "合成 Records 与 Relations",
      completeness: "partial",
    },
    {
      id: "synthetic:conversation",
      platform: "chat",
      scope: "虚构对话记录",
      completeness: "partial",
    },
    {
      id: "workspace:local",
      platform: "notes",
      scope: "虚构笔记来源，测试名称冲突",
      completeness: "unknown",
    },
  ];
  const nodes = Array.from({ length: 402 }, (_, i) => ({
    id: "synthetic:record:" + i,
    label: "合成记忆 " + i,
    type: ["memory", "project", "topic"][i % 3],
    content: "仅用于回归测试的虚构内容 " + i,
    source_id: sources[i % 3].id,
    source_ref: "synthetic:document:" + i,
    revision: 1,
    state: "confirmed",
    extensions: {
      "synthetic:record": { source_key: "record:" + i, collection: i % 18 },
    },
  }));
  const edges = Array.from({ length: 2028 }, (_, i) => ({
    id: "synthetic:relation:" + i,
    from: nodes[i % nodes.length].id,
    to: nodes[(i * 17 + 1) % nodes.length].id,
    type: "documented_link",
    basis: i % 11 ? "explicit" : "inferred",
    evidence: "测试数据中明确提供的关系 " + i,
    source_id: sources[i % 3].id,
    source_ref: "synthetic:relation-document:" + i,
  }));
  return {
    protocol: "mgp/1.1",
    source: sources[0],
    sources: sources.slice(1),
    nodes,
    edges,
  };
}
