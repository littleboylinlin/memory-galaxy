import { NODE_TYPES, NODE_STATES } from "./mgp.mjs";

export const TAB_STATE_KEY = "memory-galaxy:tab-state:1";
const views = [
  "graph",
  "list",
  "review",
  "health",
  "timeline",
  "history",
  "sources",
];
const page = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : 0;

export function tabState(value) {
  if (!value || value.version !== 1) return null;
  const camera = value.camera;
  return {
    version: 1,
    ...(value.insights ? { insights: insightTabState(value.insights) } : {}),
    view: views.includes(value.view) ? value.view : "graph",
    query: typeof value.query === "string" ? value.query.slice(0, 500) : "",
    typeFilter: NODE_TYPES.includes(value.typeFilter)
      ? value.typeFilter
      : "all",
    stateFilter: NODE_STATES.includes(value.stateFilter)
      ? value.stateFilter
      : "all",
    listPage: page(value.listPage),
    timelinePage: page(value.timelinePage),
    edgePage: page(value.edgePage),
    timelineMode: value.timelineMode === "activity" ? "activity" : "memory",
    selected:
      typeof value.selected === "string" && value.selected.length <= 256
        ? value.selected
        : null,
    camera:
      camera &&
      Number.isFinite(camera.zoom) &&
      camera.zoom >= 0.000001 &&
      camera.zoom <= 6 &&
      [camera.x, camera.y].every(
        (coordinate) =>
          Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e9,
      )
        ? { zoom: camera.zoom, x: camera.x, y: camera.y }
        : null,
  };
}

export function insightTabState(value) {
  return {
    reviewMode: [
      "due",
      "favorites",
      "reviewed",
      "skipped",
      "undated",
      "all",
    ].includes(value?.reviewMode)
      ? value.reviewMode
      : "due",
    reviewAge: [30, 90, 180].includes(value?.reviewAge) ? value.reviewAge : 30,
    reviewPage: page(value?.reviewPage),
    healthKind: ["duplicates", "isolated", "sources", "stale"].includes(
      value?.healthKind,
    )
      ? value.healthKind
      : "duplicates",
    healthAge: [30, 90, 180].includes(value?.healthAge) ? value.healthAge : 90,
    healthPage: page(value?.healthPage),
  };
}

export function readTabState(storage) {
  try {
    const text = (storage ?? sessionStorage).getItem(TAB_STATE_KEY);
    if (!text || text.length > 16384) return null;
    return tabState(JSON.parse(text));
  } catch {
    return null;
  }
}

export function writeTabState(value, storage) {
  try {
    const state = tabState(value);
    if (!state) return false;
    (storage ?? sessionStorage).setItem(TAB_STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
