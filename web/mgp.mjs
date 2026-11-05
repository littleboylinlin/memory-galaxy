/** Memory Graph Protocol: validation, import planning, and incremental updates. */
export const PROTOCOL = "mgp/1.1";
export const SUPPORTED_PROTOCOLS = ["mgp/1.0", PROTOCOL];
export const LIMITS = Object.freeze({
  bytes: 12 * 1024 * 1024,
  nodes: 50000,
  edges: 250000,
  text: 100000,
  depth: 24,
  issues: 100,
  sources: 1000,
});
export const NODE_TYPES = [
  "memory",
  "person",
  "project",
  "topic",
  "event",
  "preference",
  "goal",
  "skill",
  "other",
];
export const NODE_STATES = [
  "confirmed",
  "inferred",
  "deprecated",
  "disputed",
  "unknown",
];
export const EDGE_BASES = ["explicit", "inferred", "rule"];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(o));
const text = (s) => typeof s === "string" && s.trim().length > 0;
const validId = (s) => text(s) && s.length <= 256 && !/[\u0000-\u001f]/.test(s);
const timestamp = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  validCalendar(s);
function validCalendar(s) {
  const year = Number(s.slice(0, 4)),
    month = Number(s.slice(5, 7)),
    day = Number(s.slice(8, 10));
  const max = new Date(
    Date.UTC(year === 0 ? 400 : year, month, 0),
  ).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= max &&
    Number(s.slice(11, 13)) < 24 &&
    Number(s.slice(14, 16)) < 60 &&
    Number(s.slice(17, 19)) < 60 &&
    (s.endsWith("Z") ||
      (Number(s.slice(-5, -3)) < 24 && Number(s.slice(-2)) < 60))
  );
}
export const edgeKey = (edge) =>
  edge.id
    ? "id:" + edge.id
    : "triple:" + JSON.stringify([edge.from, edge.to, edge.type]);
const fields = {
  graph: [
    "protocol",
    "source",
    "sources",
    "mode",
    "batch_id",
    "nodes",
    "edges",
    "deleted",
    "extensions",
  ],
  source: [
    "id",
    "platform",
    "scope",
    "completeness",
    "exported_at",
    "extensions",
  ],
  node: [
    "id",
    "label",
    "type",
    "content",
    "tags",
    "state",
    "source_id",
    "source_ref",
    "provenance",
    "updated_at",
    "revision",
    "sensitive",
    "extensions",
  ],
  edge: [
    "id",
    "from",
    "to",
    "type",
    "basis",
    "evidence",
    "source_id",
    "source_ref",
    "provenance",
    "updated_at",
    "revision",
    "extensions",
  ],
  provenance: ["source_id", "ref"],
  deleted: ["nodes", "edges"],
  deletedNode: ["id", "deleted_at", "source_id", "source_ref"],
  deletedEdge: [
    "id",
    "from",
    "to",
    "type",
    "deleted_at",
    "source_id",
    "source_ref",
  ],
};
const WORKSPACE_SOURCE = {
  id: "workspace:local",
  platform: "local",
  scope: "当前工作区",
  completeness: "unknown",
};
export class MgpError extends Error {
  constructor(issues) {
    super(
      issues
        .map(
          (i) =>
            (i.line
              ? "第 " + i.line + " 行，第 " + (i.column || 1) + " 列 · "
              : "") +
            i.path +
            ": " +
            i.message,
        )
        .join("\n"),
    );
    this.name = "MgpError";
    this.issues = issues;
  }
}
function walkSafe(value, issue) {
  const stack = [{ value, path: "$", depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++visited > 2000000) {
      issue("$", "数据结构过大", "limit");
      return;
    }
    if (item.depth > LIMITS.depth) {
      issue(item.path, "嵌套超过 " + LIMITS.depth + " 层", "depth");
      return;
    }
    if (typeof item.value === "number" && !Number.isFinite(item.value))
      issue(item.path, "数字必须有限", "number");
    if (item.value === null || typeof item.value !== "object") continue;
    if (!Array.isArray(item.value) && !object(item.value)) {
      issue(item.path, "必须是普通 JSON 对象", "object");
      return;
    }
    for (const key of Object.keys(item.value)) {
      const childPath = Array.isArray(item.value)
        ? item.path + "[" + key + "]"
        : item.path === "$"
          ? key
          : item.path + "." + key;
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        issue(childPath, "不允许的对象属性", "unsafe_key");
        return;
      }
      const child = item.value[key];
      if (child !== null && typeof child === "object")
        stack.push({ value: child, path: childPath, depth: item.depth + 1 });
      else if (typeof child === "number" && !Number.isFinite(child))
        issue(childPath, "数字必须有限", "number");
      else if (
        !["string", "number", "boolean"].includes(typeof child) &&
        child !== null
      )
        issue(childPath, "不是 JSON 值", "value");
    }
  }
}
export function validateMgp(value, knownIds = []) {
  const issues = [],
    warnings = [];
  const legacy = value?.protocol === "mgp/1.0";
  const issue = (path, message, code = "invalid") => {
    if (issues.length < LIMITS.issues) issues.push({ path, message, code });
  };
  const shape = (o, kind, path) => {
    if (!object(o)) {
      issue(path, "必须是对象");
      return false;
    }
    for (const key of Object.keys(o))
      if (!fields[kind].includes(key) && (!legacy || kind === "provenance"))
        issue(
          path + "." + key,
          "未知字段；自定义数据请放在 extensions 中",
          "unknown_field",
        );
    if (own(o, "extensions") && !object(o.extensions))
      issue(path + ".extensions", "必须是对象");
    return true;
  };
  const id = (s, path) => {
    if (!validId(s))
      issue(path, "需要 1～256 字符的稳定 ID，不能包含控制字符", "id");
  };
  const string = (s, path, max, required = false) => {
    if (s === undefined && !required) return;
    if (typeof s !== "string" || (required && !s.trim()) || s.length > max)
      issue(
        path,
        "需要" + (required ? "非空" : "") + "文本，最长 " + max + " 字符",
        "text",
      );
  };
  const date = (s, path) => {
    if (s !== undefined && !timestamp(s))
      issue(path, "需要带时区的 ISO 8601 日期时间", "timestamp");
  };
  walkSafe(value, issue);
  if (issues.length) return result();
  if (!shape(value, "graph", "$")) return result();
  if (!SUPPORTED_PROTOCOLS.includes(value.protocol))
    issue(
      "protocol",
      "不支持此版本；支持 " + SUPPORTED_PROTOCOLS.join(" / "),
      "version",
    );
  if (value.mode !== undefined && !["snapshot", "delta"].includes(value.mode))
    issue("mode", "只能是 snapshot / delta");
  if (
    value.protocol === "mgp/1.0" &&
    (value.mode === "delta" || value.deleted !== undefined)
  )
    issue("protocol", "增量删除需要 mgp/1.1", "version");
  if (value.batch_id !== undefined) id(value.batch_id, "batch_id");
  const sourceIds = new Set();
  function source(s, path) {
    if (!shape(s, "source", path)) return;
    id(s.id, path + ".id");
    if (validId(s.id)) sourceIds.add(s.id);
    string(s.platform, path + ".platform", 200);
    string(s.scope, path + ".scope", 2000);
    date(s.exported_at, path + ".exported_at");
    if (
      s.completeness !== undefined &&
      !["full", "partial", "unknown"].includes(s.completeness)
    )
      issue(path + ".completeness", "只能是 full / partial / unknown");
    if (s.completeness === "full")
      warnings.push(path + ": full 仅为导出方声明，星盘无法独立证明全量覆盖");
  }
  source(value.source, "source");
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > LIMITS.sources)
      issue("sources", "需要数组，最多 " + LIMITS.sources + " 个来源", "limit");
    else {
      const seen = new Set();
      value.sources.forEach((s, i) => {
        source(s, "sources[" + i + "]");
        if (seen.has(s?.id))
          issue("sources[" + i + "].id", "重复来源 ID", "duplicate");
        if (s?.id === value.source?.id && !equal(s, value.source))
          issue("sources[" + i + "].id", "同一来源存在不一致的声明", "source");
        seen.add(s?.id);
      });
    }
  }
  for (const kind of ["nodes", "edges"])
    if (!Array.isArray(value[kind])) issue(kind, "必须是数组");
  if (issues.length) return result();
  if (value.nodes.length > LIMITS.nodes || value.edges.length > LIMITS.edges) {
    issue(
      "$",
      "单批最多 " + LIMITS.nodes + " 个节点 / " + LIMITS.edges + " 条关系",
      "limit",
    );
    return result();
  }
  const ids = new Set(),
    allIds = new Set(knownIds),
    deletedNodes = new Set(),
    deletedEdges = new Set();
  if (
    value.deleted !== undefined &&
    shape(value.deleted, "deleted", "deleted")
  ) {
    for (const kind of ["nodes", "edges"]) {
      const items =
        value.deleted[kind] === undefined ? [] : value.deleted[kind];
      if (
        !Array.isArray(items) ||
        items.length > (kind === "nodes" ? LIMITS.nodes : LIMITS.edges)
      ) {
        issue("deleted." + kind, "删除记录过多或不是数组", "limit");
        continue;
      }
      items.forEach((d, i) => {
        const path = "deleted." + kind + "[" + i + "]";
        if (!shape(d, kind === "nodes" ? "deletedNode" : "deletedEdge", path))
          return;
        if (!timestamp(d.deleted_at))
          issue(
            path + ".deleted_at",
            "删除记录需要带时区的 deleted_at",
            "timestamp",
          );
        if (d.source_id !== undefined) {
          id(d.source_id, path + ".source_id");
          if (!sourceIds.has(d.source_id))
            issue(path + ".source_id", "来源未声明", "source");
        }
        string(d.source_ref, path + ".source_ref", 2000);
        if (kind === "nodes") {
          id(d.id, path + ".id");
          if (deletedNodes.has(d.id))
            issue(path + ".id", "重复删除记录", "duplicate");
          deletedNodes.add(d.id);
        } else {
          if (d.id !== undefined) id(d.id, path + ".id");
          for (const key of ["from", "to", "type"])
            if (d.id === undefined || d[key] !== undefined)
              id(d[key], path + "." + key);
          const key = edgeKey(d);
          if (deletedEdges.has(key)) issue(path, "重复删除记录", "duplicate");
          deletedEdges.add(key);
        }
      });
    }
  }
  function common(n, path) {
    date(n.updated_at, path + ".updated_at");
    if (
      n.revision !== undefined &&
      (!Number.isSafeInteger(n.revision) || n.revision < 1)
    )
      issue(path + ".revision", "需要正的安全整数");
    if (n.source_id !== undefined) {
      id(n.source_id, path + ".source_id");
      if (!sourceIds.has(n.source_id))
        issue(
          path + ".source_id",
          "来源 ID 未在 source/sources 中声明",
          "source",
        );
    }
    string(n.source_ref, path + ".source_ref", 2000);
    if (n.provenance !== undefined) {
      if (!Array.isArray(n.provenance) || n.provenance.length > LIMITS.sources)
        issue(
          path + ".provenance",
          "来源追溯需要数组，最多 " + LIMITS.sources + " 条",
          "limit",
        );
      else
        n.provenance.forEach((p, j) => {
          const q = path + ".provenance[" + j + "]";
          if (!shape(p, "provenance", q)) return;
          id(p.source_id, q + ".source_id");
          if (!sourceIds.has(p.source_id))
            issue(q + ".source_id", "来源未声明", "source");
          string(p.ref, q + ".ref", 2000);
        });
    }
  }
  value.nodes.forEach((n, i) => {
    const p = "nodes[" + i + "]";
    if (!shape(n, "node", p)) return;
    id(n.id, p + ".id");
    if (ids.has(n.id)) issue(p + ".id", "重复节点 ID", "duplicate");
    else {
      ids.add(n.id);
      allIds.add(n.id);
    }
    if (deletedNodes.has(n.id))
      issue(p + ".id", "同一批次不能同时更新和删除节点", "operation");
    string(n.label, p + ".label", 200, true);
    string(n.content, p + ".content", LIMITS.text);
    if (!NODE_TYPES.includes(n.type)) issue(p + ".type", "不支持的节点类别");
    if (n.state !== undefined && !NODE_STATES.includes(n.state))
      issue(p + ".state", "不支持的节点状态");
    if (
      n.tags !== undefined &&
      (!Array.isArray(n.tags) ||
        n.tags.length > 100 ||
        n.tags.some((t) => !text(t) || t.length > 100))
    )
      issue(p + ".tags", "需要最多 100 个非空字符串，每项最长 100 字符");
    if (n.sensitive !== undefined && typeof n.sensitive !== "boolean")
      issue(p + ".sensitive", "需要布尔值");
    common(n, p);
  });
  for (const removed of deletedNodes) allIds.delete(removed);
  const keys = new Set();
  value.edges.forEach((e, i) => {
    const p = "edges[" + i + "]";
    if (!shape(e, "edge", p)) return;
    if (e.id !== undefined) id(e.id, p + ".id");
    id(e.from, p + ".from");
    id(e.to, p + ".to");
    id(e.type, p + ".type");
    if (!allIds.has(e.from))
      issue(p + ".from", "引用了不存在或本批已删除的节点", "reference");
    if (!allIds.has(e.to))
      issue(p + ".to", "引用了不存在或本批已删除的节点", "reference");
    if (!EDGE_BASES.includes(e.basis))
      issue(p + ".basis", "需要 explicit / inferred / rule");
    string(e.evidence, p + ".evidence", 10000);
    common(e, p);
    const key = edgeKey(e);
    if (keys.has(key)) {
      if (value.protocol === "mgp/1.0") warnings.push(p + ": 重复关系，将去重");
      else issue(p, "重复关系 ID 或重复的 from/to/type", "duplicate");
    }
    keys.add(key);
    if (deletedEdges.has(key))
      issue(p, "同一批次不能同时更新和删除关系", "operation");
    if (e.from === e.to) warnings.push(p + ": 自环关系");
  });
  return result();
  function result() {
    return {
      ok: issues.length === 0,
      issues,
      errors: issues.map((i) => i.path + ": " + i.message),
      warnings: [...new Set(warnings)],
    };
  }
}
function syntaxIssue(error, text, lineOffset = 0) {
  const match = error.message.match(/position (\d+)/i),
    direct = error.message.match(/line (\d+) column (\d+)/i);
  const offset = match ? Math.min(text.length, Number(match[1])) : text.length;
  const before = text.slice(0, offset),
    lines = before.split("\n");
  return {
    path: "$",
    code: "json",
    message: "JSON 解析失败：" + error.message,
    line: lineOffset + (direct ? Number(direct[1]) : lines.length),
    column: direct ? Number(direct[2]) : lines.at(-1).length + 1,
  };
}
function locateIssues(text, issues) {
  const wanted = new Set(["$"]),
    positions = new Map();
  let pos = 0,
    line = 1,
    column = 1;
  const parent = (path) => path.replace(/\.[^.\[]+$|\[\d+\]$/, "");
  for (const issue of issues) {
    let path = issue.path;
    while (path && path !== "$") {
      wanted.add(path);
      const next = parent(path);
      if (next === path) break;
      path = next;
    }
  }
  const advance = () => {
    if (text[pos++] === "\n") {
      line++;
      column = 1;
    } else column++;
  };
  const space = () => {
    while (pos < text.length && /\s/.test(text[pos])) advance();
  };
  function string() {
    const start = pos;
    advance();
    while (pos < text.length) {
      const c = text[pos];
      advance();
      if (c === "\\") {
        advance();
      } else if (c === '"') break;
    }
    return JSON.parse(text.slice(start, pos));
  }
  function value(path, depth = 0) {
    space();
    if (wanted.has(path)) positions.set(path, { line, column });
    if (depth > LIMITS.depth + 2) return;
    if (text[pos] === "{") {
      advance();
      space();
      while (text[pos] !== "}" && pos < text.length) {
        const key = string();
        space();
        advance();
        value(path === "$" ? key : path + "." + key, depth + 1);
        space();
        if (text[pos] !== ",") break;
        advance();
        space();
      }
      advance();
    } else if (text[pos] === "[") {
      advance();
      space();
      let i = 0;
      while (text[pos] !== "]" && pos < text.length) {
        value(path + "[" + i++ + "]", depth + 1);
        space();
        if (text[pos] !== ",") break;
        advance();
      }
      advance();
    } else if (text[pos] === '"') string();
    else while (pos < text.length && !/[\s,\]}]/.test(text[pos])) advance();
  }
  try {
    value("$");
  } catch {
    /* JSON syntax errors are reported by JSON.parse. */
  }
  for (const issue of issues) {
    let path = issue.path;
    while (!positions.has(path) && path !== "$") {
      const next = parent(path);
      path = next === path ? "$" : next;
    }
    Object.assign(issue, positions.get(path) || { line: 1, column: 1 });
  }
  return issues;
}
export function parseMgp(input, knownIds = []) {
  if (typeof input !== "string")
    throw new MgpError([
      { path: "$", message: "输入必须是文本", code: "type" },
    ]);
  if (new TextEncoder().encode(input).length > LIMITS.bytes)
    throw new MgpError([
      { path: "$", message: "输入超过 12 MiB，请分批导入", code: "limit" },
    ]);
  const body = input.replace(/^\uFEFF/, "");
  if (!body.trim())
    throw new MgpError([
      {
        path: "$",
        message: "请粘贴 JSON 或选择文件",
        code: "empty",
        line: 1,
        column: 1,
      },
    ]);
  let graph,
    format = "json",
    locations;
  let parseError;
  try {
    graph = JSON.parse(body);
  } catch (error) {
    parseError = error;
  }
  if (parseError || graph?.kind === "header") {
    const lines = body.split("\n"),
      records = [];
    let header;
    try {
      header = JSON.parse(lines.find((s) => s.trim()) || "");
    } catch {
      throw new MgpError([syntaxIssue(parseError, body)]);
    }
    if (header?.kind !== "header")
      throw new MgpError([syntaxIssue(parseError, body)]);
    format = "jsonl";
    locations = new Map();
    let headerLine = 0;
    for (let i = 0; i < lines.length; i++)
      if (lines[i].trim()) {
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch (e) {
          throw new MgpError([syntaxIssue(e, lines[i], i)]);
        }
        if (!records.length) {
          headerLine = i + 1;
          records.push(record);
          continue;
        }
        records.push({ record, line: i + 1 });
      }
    const { kind, ...metadata } = header;
    if (
      own(metadata, "nodes") ||
      own(metadata, "edges") ||
      own(metadata, "deleted")
    )
      throw new MgpError([
        {
          path: "header",
          line: headerLine,
          column: 1,
          code: "jsonl",
          message: "JSONL 头记录不能内嵌节点、关系或删除记录",
        },
      ]);
    graph = {
      ...metadata,
      nodes: [],
      edges: [],
      deleted: { nodes: [], edges: [] },
    };
    if (graph.protocol === "mgp/1.0") delete graph.deleted;
    for (const { record, line } of records.slice(1)) {
      if (
        !object(record) ||
        Object.keys(record).some((k) => !["kind", "value"].includes(k))
      )
        throw new MgpError([
          {
            path: "record",
            line,
            column: 1,
            code: "jsonl",
            message: "记录只允许 kind 和 value",
          },
        ]);
      const targets = {
        node: ["nodes"],
        edge: ["edges"],
        delete_node: ["deleted", "nodes"],
        delete_edge: ["deleted", "edges"],
      };
      const path =
        typeof record.kind === "string" && own(targets, record.kind)
          ? targets[record.kind]
          : undefined;
      if (!path)
        throw new MgpError([
          {
            path: "kind",
            line,
            column: 1,
            code: "jsonl",
            message: "记录类型需要 node / edge / delete_node / delete_edge",
          },
        ]);
      if (path.length === 2 && !graph.deleted)
        throw new MgpError([
          {
            path: "protocol",
            line,
            column: 1,
            code: "version",
            message: "删除记录需要 mgp/1.1",
          },
        ]);
      const items =
        path.length === 1 ? graph[path[0]] : graph[path[0]][path[1]];
      locations.set(path.join(".") + "[" + items.length + "]", {
        line,
        text: lines[line - 1],
      });
      items.push(record.value);
    }
    locations.set("source", headerLine);
    locations.set("protocol", headerLine);
    locations.set("$", headerLine);
  }
  const checked = validateMgp(graph, knownIds);
  if (!checked.ok) {
    if (format === "json") locateIssues(body, checked.issues);
    else
      for (const issue of checked.issues) {
        const root = issue.path.match(
          /^(?:deleted\.)?(?:nodes|edges)\[\d+\]/,
        )?.[0];
        const record = root && locations.get(root);
        if (record) {
          const located = locateIssues(record.text, [
            { ...issue, path: "value" + issue.path.slice(root.length) },
          ])[0];
          issue.line = record.line + located.line - 1;
          issue.column = located.column;
        } else {
          const located = locateIssues(linesForHeader(body), [{ ...issue }])[0];
          issue.line = (locations.get("$") || 1) + located.line - 1;
          issue.column = located.column;
        }
      }
    throw new MgpError(checked.issues);
  }
  const normalized = normalizeLegacy(graph);
  return {
    graph: normalized.graph,
    warnings: [...checked.warnings, ...normalized.warnings],
    format,
  };
}
function linesForHeader(body) {
  return body.split("\n").find((line) => line.trim()) || "";
}
function normalizeLegacy(value) {
  if (value.protocol !== "mgp/1.0") return { graph: value, warnings: [] };
  let changed = 0;
  function record(input, kind) {
    if (!object(input)) return input;
    const extra = Object.keys(input).filter(
      (key) => !fields[kind].includes(key),
    );
    if (!extra.length) return input;
    changed++;
    const output = {
      ...input,
      extensions: structuredClone(input.extensions || {}),
    };
    let namespace = "mgp:legacy-fields",
      suffix = 0;
    while (own(output.extensions, namespace))
      namespace = "mgp:legacy-fields:" + ++suffix;
    output.extensions[namespace] = Object.fromEntries(
      extra.map((key) => [key, structuredClone(input[key])]),
    );
    for (const key of extra) delete output[key];
    return output;
  }
  const graph = {
    ...record(value, "graph"),
    source: record(value.source, "source"),
    nodes: value.nodes.map((n) => record(n, "node")),
    edges: value.edges.map((e) => record(e, "edge")),
  };
  if (value.sources)
    graph.sources = value.sources.map((s) => record(s, "source"));
  return {
    graph,
    warnings: changed
      ? [
          "旧版数据的 " +
            changed +
            " 处额外字段已保留在 extensions 的 mgp:legacy-fields 命名空间中。",
        ]
      : [],
  };
}
export function stringifyMgp(graph, format = "json") {
  const valid = validateMgp(graph);
  if (!valid.ok) throw new MgpError(valid.issues);
  if (format === "json") return JSON.stringify(graph, null, 2);
  if (format !== "jsonl") throw new Error("不支持的导出格式");
  const { nodes, edges, deleted, ...header } = graph;
  const records = [
    { kind: "header", ...header },
    ...nodes.map((value) => ({ kind: "node", value })),
    ...edges.map((value) => ({ kind: "edge", value })),
    ...(deleted?.nodes || []).map((value) => ({ kind: "delete_node", value })),
    ...(deleted?.edges || []).map((value) => ({ kind: "delete_edge", value })),
  ];
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
export function emptyGraph() {
  return {
    protocol: PROTOCOL,
    source: { ...WORKSPACE_SOURCE },
    sources: [],
    nodes: [],
    edges: [],
    deleted: { nodes: [], edges: [] },
  };
}
export function graphSources(graph) {
  const sources = new Map((graph?.sources || []).map((s) => [s.id, s]));
  if (graph?.source && !isAggregateSource(graph))
    sources.set(graph.source.id, graph.source);
  return [...sources.values()];
}
function isAggregateSource(graph) {
  const source = graph.source;
  if (
    !/^workspace:local(?::[1-9]\d*)?$/.test(source.id) ||
    !equal(source, { ...WORKSPACE_SOURCE, id: source.id })
  )
    return false;
  return [
    graph.nodes || [],
    graph.edges || [],
    graph.deleted?.nodes || [],
    graph.deleted?.edges || [],
  ].every((records) =>
    records.every(
      (record) =>
        (record.source_id || source.id) !== source.id &&
        !record.provenance?.some((item) => item.source_id === source.id),
    ),
  );
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const claim = (record) => {
  const { provenance, source_id, source_ref, ...value } = record;
  return value;
};
function withProvenance(record, sourceId, existing) {
  const next = {
    ...structuredClone(record),
    source_id: record.source_id || sourceId,
  };
  const provenance = new Map();
  for (const p of [
    ...structuredClone(existing?.provenance || []),
    ...(next.provenance || []),
    {
      source_id: next.source_id,
      ...(record.source_ref ? { ref: record.source_ref } : {}),
    },
  ])
    provenance.set(JSON.stringify([p.source_id, p.ref ?? null]), p);
  next.provenance = [...provenance.values()];
  return next;
}
function updatedRecord(previous, next) {
  const merged = { ...previous, ...next };
  if (previous.source_id !== next.source_id)
    for (const key of ["source_ref", "revision"])
      if (!own(next, key)) delete merged[key];
  return withProvenance(merged, next.source_id, previous);
}
function compareVersion(incoming, existing, deletion = false) {
  if (deletion) {
    const a = incoming.deleted_at || incoming.updated_at,
      b = existing.deleted_at || existing.updated_at;
    return a && b ? Math.sign(Date.parse(a) - Date.parse(b)) : null;
  }
  if (
    incoming.revision !== undefined &&
    existing.revision !== undefined &&
    incoming.source_id === existing.source_id
  )
    return Math.sign(incoming.revision - existing.revision);
  const a = incoming.updated_at || incoming.exported_at,
    b = existing.updated_at || existing.exported_at;
  if (a && b) return Math.sign(Date.parse(a) - Date.parse(b));
  return null;
}
export function planImport(
  base,
  incoming,
  { policy = "review", choices = {} } = {},
) {
  if (!["review", "keep", "incoming", "newer"].includes(policy))
    throw new Error("未知冲突策略");
  base = base || emptyGraph();
  let valid = validateMgp(base);
  if (!valid.ok) throw new MgpError(valid.issues);
  valid = validateMgp(
    incoming,
    base.nodes.map((n) => n.id),
  );
  if (!valid.ok) throw new MgpError(valid.issues);
  const normalizedBase = normalizeLegacy(base),
    normalizedIncoming = normalizeLegacy(incoming);
  base = normalizedBase.graph;
  incoming = normalizedIncoming.graph;
  const warnings = [
      ...valid.warnings,
      ...normalizedBase.warnings,
      ...normalizedIncoming.warnings,
    ],
    conflicts = [];
  const stats = {
    addedNodes: 0,
    updatedNodes: 0,
    deletedNodes: 0,
    addedEdges: 0,
    updatedEdges: 0,
    deletedEdges: 0,
    unchanged: 0,
  };
  const nodes = new Map(
    base.nodes.map((n) => [
      n.id,
      withProvenance(n, n.source_id || base.source.id),
    ]),
  );
  const edges = new Map(
    base.edges.map((e) => [
      edgeKey(e),
      withProvenance(e, e.source_id || base.source.id),
    ]),
  );
  const edgeReferences = new Map(),
    originalEdges = new Map(edges);
  for (const [key, edge] of edges)
    for (const id of new Set([edge.from, edge.to])) {
      if (!edgeReferences.has(id)) edgeReferences.set(id, []);
      edgeReferences.get(id).push(key);
    }
  const deletedNodes = new Map(
    (base.deleted?.nodes || []).map((d) => [d.id, { ...d }]),
  );
  const deletedEdges = new Map(
    (base.deleted?.edges || []).map((d) => [edgeKey(d), { ...d }]),
  );
  function resolve(kind, key, existing, next, deletion = false) {
    const decisionKey = kind + ":" + key;
    let decision = choices[decisionKey] || policy;
    if (!["review", "keep", "incoming", "newer"].includes(decision))
      throw new Error("未知逐项冲突策略");
    const order = compareVersion(next, existing, deletion);
    if (decision === "newer")
      decision =
        order === null || order === 0
          ? "review"
          : order > 0
            ? "incoming"
            : "keep";
    conflicts.push({
      key: decisionKey,
      kind,
      id: next.id || key,
      existing: structuredClone(existing),
      incoming: structuredClone(next),
      resolution: decision === "review" ? null : decision,
    });
    return decision === "incoming";
  }
  for (const n of incoming.nodes) {
    const next = withProvenance(n, n.source_id || incoming.source.id),
      previous = nodes.get(n.id),
      tombstone = deletedNodes.get(n.id);
    if (tombstone && !resolve("restore-node", n.id, tombstone, next, true))
      continue;
    if (previous) {
      if (equal(claim(previous), claim({ ...previous, ...next }))) {
        nodes.set(n.id, withProvenance(previous, previous.source_id, next));
        stats.unchanged++;
        continue;
      }
      if (!resolve("node", n.id, previous, next)) continue;
      nodes.set(n.id, updatedRecord(previous, next));
      stats.updatedNodes++;
    } else {
      nodes.set(n.id, next);
      stats.addedNodes++;
    }
    deletedNodes.delete(n.id);
  }
  for (const d of incoming.deleted?.nodes || []) {
    const previous = nodes.get(d.id),
      oldTombstone = deletedNodes.get(d.id);
    if (previous && !resolve("delete-node", d.id, previous, d, true)) continue;
    if (
      oldTombstone &&
      Date.parse(oldTombstone.deleted_at) >= Date.parse(d.deleted_at)
    ) {
      stats.unchanged++;
      continue;
    }
    if (nodes.delete(d.id)) stats.deletedNodes++;
    deletedNodes.set(d.id, {
      ...d,
      source_id: d.source_id || incoming.source.id,
    });
    for (const key of edgeReferences.get(d.id) || []) {
      const edge = originalEdges.get(key),
        previous = deletedEdges.get(key);
      if (edges.delete(key)) stats.deletedEdges++;
      if (
        !previous ||
        Date.parse(previous.deleted_at) < Date.parse(d.deleted_at)
      )
        deletedEdges.set(key, {
          ...(edge.id
            ? { id: edge.id }
            : { from: edge.from, to: edge.to, type: edge.type }),
          deleted_at: d.deleted_at,
          source_id: d.source_id || incoming.source.id,
        });
    }
  }
  for (const e of incoming.edges) {
    const key = edgeKey(e),
      next = withProvenance(e, e.source_id || incoming.source.id),
      previous = edges.get(key),
      tombstone = deletedEdges.get(key);
    if (tombstone && !resolve("restore-edge", key, tombstone, next, true))
      continue;
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      const accepted = resolve(
        "edge-dependency",
        key,
        { reason: "关系端点未被保留" },
        next,
      );
      if (accepted) {
        conflicts.at(-1).resolution = null;
        warnings.push(
          "关系 " + key + " 的端点未保留；如需采用，请先恢复对应节点。",
        );
      } else if (conflicts.at(-1).resolution === "keep")
        warnings.push("关系 " + key + " 未导入：你选择保留当前已删除的端点。");
      continue;
    }
    if (previous) {
      if (equal(claim(previous), claim({ ...previous, ...next }))) {
        edges.set(key, withProvenance(previous, previous.source_id, next));
        stats.unchanged++;
        continue;
      }
      if (!resolve("edge", key, previous, next)) continue;
      edges.set(key, updatedRecord(previous, next));
      stats.updatedEdges++;
    } else {
      edges.set(key, next);
      stats.addedEdges++;
    }
    deletedEdges.delete(key);
  }
  for (const d of incoming.deleted?.edges || []) {
    const key = edgeKey(d),
      previous = edges.get(key),
      oldTombstone = deletedEdges.get(key);
    if (previous && !resolve("delete-edge", key, previous, d, true)) continue;
    if (
      oldTombstone &&
      Date.parse(oldTombstone.deleted_at) >= Date.parse(d.deleted_at)
    ) {
      stats.unchanged++;
      continue;
    }
    if (edges.delete(key)) stats.deletedEdges++;
    deletedEdges.set(key, {
      ...d,
      source_id: d.source_id || incoming.source.id,
    });
  }
  const sources = new Map(
    graphSources(base).map((s) => [s.id, structuredClone(s)]),
  );
  for (const s of graphSources(incoming)) {
    const previous = sources.get(s.id);
    if (
      previous &&
      !equal(previous, s) &&
      !resolve("source", s.id, previous, s)
    )
      continue;
    sources.set(s.id, structuredClone(s));
  }
  let workspaceSourceId = WORKSPACE_SOURCE.id,
    suffix = 0;
  while (sources.has(workspaceSourceId))
    workspaceSourceId = WORKSPACE_SOURCE.id + ":" + ++suffix;
  const graph = {
    ...emptyGraph(),
    source: { ...WORKSPACE_SOURCE, id: workspaceSourceId },
    sources: [...sources.values()],
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    deleted: {
      nodes: [...deletedNodes.values()],
      edges: [...deletedEdges.values()],
    },
  };
  if (base.extensions || incoming.extensions) {
    graph.extensions = structuredClone(base.extensions || {});
    for (const [key, value] of Object.entries(incoming.extensions || {})) {
      if (
        own(graph.extensions, key) &&
        !equal(graph.extensions[key], value) &&
        !resolve("extension", key, { value: graph.extensions[key] }, { value })
      )
        continue;
      graph.extensions[key] = structuredClone(value);
    }
  }
  valid = validateMgp(graph);
  if (!valid.ok) throw new MgpError(valid.issues);
  if (graph.nodes.length > 2000)
    warnings.push(
      "此工作区包含 " +
        graph.nodes.length.toLocaleString() +
        " 个节点，星图渲染可能较慢。",
    );
  if (new TextEncoder().encode(JSON.stringify(graph)).length > LIMITS.bytes)
    throw new MgpError([
      {
        path: "$",
        code: "limit",
        message: "合并结果超过 12 MiB，请拆分工作区",
      },
    ]);
  const unresolved = conflicts.filter((c) => !c.resolution).length;
  return {
    graph,
    stats,
    conflicts,
    unresolved,
    warnings: [...new Set(warnings)],
    canApply: unresolved === 0,
  };
}
export function mergeMgp(base, incoming, options = { policy: "incoming" }) {
  const plan = planImport(base, incoming, options);
  if (!plan.canApply)
    throw new MgpError([
      {
        path: "conflicts",
        code: "conflict",
        message: "仍有 " + plan.unresolved + " 项冲突需要处理",
      },
    ]);
  return plan.graph;
}

export const example = {
  protocol: PROTOCOL,
  source: {
    id: "demo:fictional",
    platform: "example",
    scope: "示例数据",
    completeness: "partial",
    exported_at: "2026-01-01T00:00:00Z",
  },
  nodes: [
    {
      id: "demo:project:galaxy",
      label: "记忆星盘",
      type: "project",
      content: "通过开放数据协议呈现任意来源的记忆。",
      state: "confirmed",
    },
    {
      id: "demo:topic:graph",
      label: "知识图谱",
      type: "topic",
      content: "以节点和关系表示知识。",
      state: "confirmed",
    },
    {
      id: "demo:topic:protocol",
      label: "统一协议",
      type: "topic",
      content: "让各平台自行生成结构化 JSON。",
      state: "confirmed",
    },
    {
      id: "demo:skill:javascript",
      label: "JavaScript",
      type: "skill",
      content: "使用原生 JavaScript 和 Canvas 绘制交互星图。",
      state: "confirmed",
    },
    {
      id: "demo:topic:import",
      label: "复制粘贴导入",
      type: "topic",
      state: "confirmed",
    },
    {
      id: "demo:topic:traceability",
      label: "来源可追溯",
      type: "topic",
      state: "confirmed",
    },
    {
      id: "demo:goal:privacy",
      label: "隐私优先",
      type: "goal",
      state: "confirmed",
    },
    {
      id: "demo:topic:offline",
      label: "离线运行",
      type: "topic",
      state: "confirmed",
    },
  ],
  edges: [
    {
      from: "demo:project:galaxy",
      to: "demo:topic:graph",
      type: "uses",
      basis: "explicit",
    },
    {
      from: "demo:project:galaxy",
      to: "demo:topic:protocol",
      type: "uses",
      basis: "explicit",
    },
    {
      from: "demo:topic:protocol",
      to: "demo:topic:import",
      type: "enables",
      basis: "explicit",
    },
    {
      from: "demo:topic:protocol",
      to: "demo:topic:traceability",
      type: "supports",
      basis: "explicit",
    },
    {
      from: "demo:project:galaxy",
      to: "demo:skill:javascript",
      type: "implemented_with",
      basis: "explicit",
    },
    {
      from: "demo:goal:privacy",
      to: "demo:topic:offline",
      type: "supports",
      basis: "explicit",
    },
    {
      from: "demo:project:galaxy",
      to: "demo:goal:privacy",
      type: "prioritizes",
      basis: "explicit",
    },
  ],
};

export function isExampleGraph(graph) {
  return equal({ ...graph, protocol: PROTOCOL }, example);
}
