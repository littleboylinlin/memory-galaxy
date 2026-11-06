// Shared by the workspace search and local topic-pack selection.
export function matchesMemory(
  node,
  { keyword = "", type = "all", state = "all", tag = "" } = {},
) {
  const query = keyword.trim().toLocaleLowerCase();
  return (
    (type === "all" || node.type === type) &&
    (state === "all" || (node.state || "unknown") === state) &&
    (!tag || (node.tags || []).includes(tag)) &&
    (!query ||
      [node.id, node.label, node.content || "", ...(node.tags || [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query))
  );
}
