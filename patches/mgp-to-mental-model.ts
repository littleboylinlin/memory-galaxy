/**
 * Adapter for R4ph3rd/not-mental-model.
 * Copy under upstream src/lib/mgp-adapter.ts before integrating.
 * Note: linkedIds cannot represent edge type/basis/evidence.
 */
import type { MentalModelNode, NodeCategory } from '../types/mental-model'

export interface MgpGraph {
  protocol: 'mgp/1.0'
  source: { id: string; platform?: string; scope?: string; completeness?: string }
  nodes: Array<{
    id: string; label: string; type: string; content?: string;
    tags?: string[]; state?: string; updated_at?: string;
    source_ref?: string; sensitive?: boolean;
  }>
  edges: Array<{
    from: string; to: string; type: string;
    basis: 'explicit' | 'inferred' | 'rule'; evidence?: string
  }>
}
const category: Record<string, NodeCategory> = {
  project: 'project', event: 'conversation', preference: 'preference',
  goal: 'goal', skill: 'skill', memory: 'fact', person: 'fact',
  topic: 'fact', other: 'fact'
}
export function convertMgpToMentalModel(
  graph: MgpGraph,
  existing: MentalModelNode[] = [],
): MentalModelNode[] {
  const now = new Date().toISOString()
  const byId = new Map(existing.map(node => [node.id, node]))
  const ids = new Set([...existing.map(n => n.id), ...graph.nodes.map(n => n.id)])
  const neighbors = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set())
    neighbors.get(edge.from)!.add(edge.to)
  }
  return graph.nodes.map(node => {
    const prev = byId.get(node.id)
    const newLinks = [...(neighbors.get(node.id) ?? [])]
    return {
      ...prev,
      id: node.id,
      category: category[node.type] ?? 'fact',
      title: node.label,
      content: node.content ?? '',
      tags: node.tags ?? [],
      confidence: node.state === 'inferred' ? 'low' : 'high',
      source: node.source_ref ?? graph.source.platform ?? graph.source.id,
      createdAt: prev?.createdAt ?? now,
      updatedAt: node.updated_at ?? now,
      linkedIds: [...new Set([...(prev?.linkedIds ?? []), ...newLinks])],
      active: node.state !== 'deprecated',
      pinned: prev?.pinned ?? false,
      memoryType: prev?.memoryType ?? 'semantic',
      scope: prev?.scope ?? graph.source.scope ?? 'Imported',
      importance: prev?.importance ?? 0.65,
      conversationIds: prev?.conversationIds ?? [],
      groupIds: prev?.groupIds ?? [],
      provenance: prev?.provenance ?? 'extracted',
      confirmed: node.state === 'inferred' ? false : (prev?.confirmed ?? true),
      sensitive: node.sensitive ?? prev?.sensitive ?? false,
    }
  })
}
