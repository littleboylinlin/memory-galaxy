import { updatedRecord } from "./mgp.mjs";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
    );
  }
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => same(value, b[i]))
  );
};

// Node/edge updates use exactly the same optional-field and provenance rules as import.
export function conflictDiff(conflict) {
  const next = ["node", "edge"].includes(conflict.kind)
    ? updatedRecord(conflict.existing, conflict.incoming)
    : conflict.incoming;
  const rows = [];
  function visit(a, b, path, depth = 0) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const before = a[key],
        after = b[key],
        field = [...path, key];
      if (same(before, after)) continue;
      if (object(before) && object(after) && depth < 10)
        visit(before, after, field, depth + 1);
      else
        rows.push({
          field,
          kind: !Object.hasOwn(a, key)
            ? "added"
            : !Object.hasOwn(b, key)
              ? "removed"
              : "changed",
          before,
          after,
        });
    }
  }
  visit(conflict.existing, next, []);
  return rows;
}
