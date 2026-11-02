import {
  createLayout,
  stepLayout,
  layoutPositions,
  pinNode,
} from "./layout.mjs";
let job = null,
  timer = null;
function send(active) {
  const positions = layoutPositions(job.state);
  self.postMessage(
    {
      type: "positions",
      generation: job.generation,
      positions,
      active,
      iteration: job.state.iteration,
    },
    [positions.buffer],
  );
  job.sent = performance.now();
}
function run() {
  timer = null;
  if (!job) return;
  const deadline = performance.now() + 14;
  do {
    stepLayout(job.state);
  } while (performance.now() < deadline && job.state.iteration < job.until);
  const active =
    job.state.iteration < job.until &&
    !(job.state.iteration > 60 && job.state.energy < 0.008);
  if (!active || performance.now() - job.sent > 90) send(active);
  if (active) timer = setTimeout(run, 0);
}
self.onmessage = ({ data }) => {
  if (data.type === "start") {
    clearTimeout(timer);
    job = {
      generation: data.generation,
      state: createLayout(data.nodes, data.edges, data.options),
      until: data.nodes.length > 10000 ? 110 : 240,
      sent: 0,
    };
    self.postMessage({
      type: "groups",
      generation: job.generation,
      groups: job.state.groups,
      assignments: job.state.assignments,
    });
    send(true);
    timer = setTimeout(run, 0);
  } else if (data.type === "pin" && job && data.generation === job.generation) {
    if (pinNode(job.state, data.id, data.x, data.y, data.pinned) && !timer) {
      job.until = job.state.iteration + 65;
      timer = setTimeout(run, 0);
    }
  } else if (data.type === "stop") {
    clearTimeout(timer);
    timer = null;
    job = null;
  }
};
