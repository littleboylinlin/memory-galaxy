import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseLibraryBackup } from "../../web/library-backup.mjs";
import { libraryFixture } from "../fixtures/desktop.mjs";

test("web migration exports the applied workspace and independent local records", async ({
  page,
}) => {
  const fixture = await libraryFixture();
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(async ({ workspace, reviews, packs }) => {
    const { saveWorkspace } = await import("./storage.mjs");
    const { saveReviewAction } = await import("./review-state.mjs");
    const { writePack } = await import("./topic-pack-store.mjs");
    await saveWorkspace(workspace);
    await saveReviewAction({
      id: reviews[0].id,
      kind: "favorite",
      value: true,
    });
    await writePack(packs[0]);
    await writePack({ ...packs[0], expectedRevision: 1, remove: true });
  }, fixture);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  if (!(await page.locator("#sidebar").isVisible()))
    await page.locator("#menuBtn").click();
  await page.locator("#webMigrationBtn").click();
  const pending = page.waitForEvent("download");
  await page.locator("#confirmAction").click();
  const file = await pending;
  const { state } = await parseLibraryBackup(
    await readFile(await file.path(), "utf8"),
  );
  expect(state.workspace.graph).toEqual(fixture.workspace.graph);
  expect(state.workspace.snapshots).toEqual(fixture.workspace.snapshots);
  expect(state.reviews).toEqual([
    { schema: 1, id: fixture.reviews[0].id, favorite: true },
  ]);
  expect(state.packs).toEqual([
    expect.objectContaining({
      id: fixture.packs[0].id,
      deleted: true,
      revision: 2,
    }),
  ]);
});
