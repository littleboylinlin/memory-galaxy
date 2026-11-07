import assert from "node:assert/strict";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { DATABASE_NAME } from "../../desktop/library.mjs";
import { libraryFixture } from "../fixtures/desktop.mjs";
import { choose, close, start } from "./harness.mjs";

const {
  MEMORY_GALAXY_PROFILE_MODE: mode,
  MEMORY_GALAXY_PROFILE_REPORT: report,
  MEMORY_GALAXY_PROFILE_DIRECTORY: profile,
  MEMORY_GALAXY_PROFILE_VERSION: version,
  MEMORY_GALAXY_V070_BACKUP: backup,
} = process.env;

test(
  "packaged application preserves the default profile and its committed records",
  { timeout: 90000 },
  async (t) => {
    assert.ok(
      ["seed", "check"].includes(mode) &&
        report &&
        profile &&
        isAbsolute(report) &&
        isAbsolute(profile),
    );
    assert.ok(process.env.MEMORY_GALAXY_INSTALLED_EXE);
    const { app, page, userData } = await start(t, { version });
    assert.equal(await realpath(userData), await realpath(profile));

    if (mode === "seed") {
      const state = await libraryFixture();
      await page.evaluate(async ({ workspace, reviews, packs }) => {
        const api = window.memoryGalaxyDesktop;
        if (await api.loadWorkspace())
          throw new Error("Default test profile is not empty");
        await api.saveWorkspace(workspace, null);
        const review = reviews[0];
        await api.saveReview({
          id: review.id,
          kind: "favorite",
          value: review.favorite,
        });
        await api.saveReview({
          id: review.id,
          kind: "reviewed",
          version: review.reviewed.fingerprint,
        });
        const pack = packs[0];
        await api.savePack({
          id: pack.id,
          config: pack.config,
          baseline: pack.baseline,
        });
      }, state);
    }
    const actual = await page.evaluate(async () => {
      const api = window.memoryGalaxyDesktop;
      const list = await api.listPacks();
      return {
        workspace: await api.loadWorkspace(),
        reviews: await api.loadReviews(),
        packs: await Promise.all(list.map(({ id }) => api.loadPack(id))),
      };
    });
    assert.equal(actual.workspace.backup.graph.nodes.length, 2);
    assert.equal(actual.workspace.backup.graph.edges.length, 1);
    assert.equal(actual.reviews[0].favorite, true);
    assert.ok(actual.reviews[0].reviewed);
    assert.ok(actual.packs[0].baseline.nodes.length);
    if (mode === "seed" && backup) {
      await choose(app, { save: backup });
      assert.equal(
        await page.evaluate(() => window.memoryGalaxyDesktop.exportBackup()),
        backup,
      );
    }
    await close(app);
    const database = await stat(join(profile, "library", DATABASE_NAME));
    assert.ok(database.size > 0);
    if (process.platform !== "win32") assert.equal(database.mode & 0o077, 0);
    if (mode === "seed")
      await writeFile(report, JSON.stringify(actual), { flag: "wx" });
    else assert.deepEqual(actual, JSON.parse(await readFile(report, "utf8")));
    t.diagnostic(
      mode === "seed"
        ? "Default profile written by the installed application."
        : "Reopened the default profile and matched its pre-install graph, review records, and topic pack fingerprints.",
    );
  },
);
