import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { parseDocument } from "yaml";
const files = (await readdir(".github/workflows")).filter((file) =>
  /\.ya?ml$/.test(file),
);
for (const file of files) {
  const document = parseDocument(
    await readFile(".github/workflows/" + file, "utf8"),
    { uniqueKeys: true },
  );
  assert.equal(document.errors.length, 0);
  const workflow = document.toJS({ maxAliasCount: 0 });
  test(
    file +
      " keeps pull request checks read-only and deployment restricted to main",
    () => {
      assert.equal(workflow.permissions.contents, "read");
      assert.equal(workflow.permissions.pages, undefined);
      assert.equal(workflow.permissions["id-token"], undefined);
      assert.equal(workflow.on.pull_request_target, undefined);
      for (const [name, job] of Object.entries(workflow.jobs)) {
        assert.ok(
          job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30,
          name,
        );
        if (Object.values(job.permissions || {}).includes("write")) {
          assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
          assert.match(job.if, /github\.event_name != 'pull_request'/);
          assert.equal(job.environment.name, "github-pages");
          assert.ok(job.needs);
        }
        for (const step of job.steps || []) {
          if (step.uses) {
            assert.match(step.uses, /^actions\/[\w-]+@[a-f0-9]{40}$/);
            if (step.uses.startsWith("actions/checkout@"))
              assert.equal(step.with["persist-credentials"], false);
          }
        }
      }
    },
  );
  test(
    file + " publishes only after checks and validates the deployed artifact",
    () => {
      const jobs = workflow.jobs;
      assert.ok(jobs.package.needs.includes("checks"));
      assert.ok(jobs.package.needs.includes("browsers"));
      assert.equal(jobs.pages.needs, "package");
      assert.equal(jobs.live.needs, "pages");
      assert.ok(
        jobs.live.steps.some(
          (step) =>
            step.run?.includes("verify:site") &&
            step.run.includes("--manifest"),
        ),
      );
      assert.ok(
        jobs.live.steps.some((step) => step.run?.includes("test:smoke")),
      );
    },
  );
}
