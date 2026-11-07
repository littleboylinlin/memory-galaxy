const searchText = (node) =>
  [node.id, node.label, node.content || "", ...(node.tags || [])]
    .join(" ")
    .toLocaleLowerCase();

// Shared by the workspace search and local topic-pack selection.
export function memoryMatcher(
  { keyword = "", type = "all", state = "all", tag = "" } = {},
  textFor = searchText,
) {
  const query = keyword.trim().toLocaleLowerCase();
  return (node) =>
    (type === "all" || node.type === type) &&
    (state === "all" || (node.state || "unknown") === state) &&
    (!tag || (node.tags || []).includes(tag)) &&
    (!query || textFor(node).includes(query));
}

export function createMemorySearch() {
  // Workspace edits replace node objects, so an old index follows its node out of memory.
  const texts = new WeakMap();
  function textFor(node) {
    let text = texts.get(node);
    if (text === undefined) {
      text = searchText(node);
      texts.set(node, text);
    }
    return text;
  }
  return (nodes, options) => nodes.filter(memoryMatcher(options, textFor));
}
