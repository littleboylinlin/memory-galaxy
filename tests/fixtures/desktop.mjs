import { Workspace } from "../../web/workspace.mjs";
import { emptyPackConfig, preparePack } from "../../web/topic-packs.mjs";
import { tabState } from "../../web/tab-state.mjs";

export const graph = {
  protocol: "mgp/1.1",
  source: { id: "test:desktop", platform: "manual", completeness: "partial" },
  nodes: [
    {
      id: "memory:original",
      label: "迁移测试记忆",
      type: "memory",
      content: "测试原文与出处",
      source_ref: "fixture:page-1",
      state: "confirmed",
      updated_at: "2001-01-01T00:00:00Z",
    },
    { id: "memory:second", label: "另一条测试记忆", type: "memory" },
  ],
  edges: [
    {
      id: "link:original",
      from: "memory:original",
      to: "memory:second",
      type: "documents",
      basis: "explicit",
      evidence: "测试关系依据",
      source_ref: "fixture:edge",
    },
  ],
};

export async function libraryFixture() {
  const now = () => "2026-01-01T00:00:00.000Z";
  const workspace = new Workspace(graph, { now });
  workspace.snapshot("已命名快照");
  const config = { ...emptyPackConfig(), title: "本地主题包" };
  return {
    workspace: workspace.backup(),
    tab: tabState({
      version: 1,
      view: "review",
      query: "测试",
      selected: graph.nodes[0].id,
    }),
    reviews: [
      {
        schema: 1,
        id: graph.nodes[0].id,
        favorite: true,
        reviewed: { at: now(), fingerprint: "a".repeat(64) },
      },
    ],
    packs: [
      {
        schema: 1,
        id: "pack:test",
        revision: 1,
        saved_at: now(),
        config,
        baseline: (await preparePack(graph, config)).baseline,
      },
      {
        schema: 1,
        id: "pack:removed",
        revision: 2,
        saved_at: now(),
        deleted: true,
      },
    ],
  };
}
