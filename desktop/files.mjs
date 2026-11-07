import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { LIBRARY_FILE_BYTES } from "../web/library-backup.mjs";

export async function readFolderSetting(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text);
  if (typeof value?.folder !== "string" || !isAbsolute(value.folder))
    throw new Error("数据文件夹设置损坏，请重新选择原来的资料库文件夹。");
  return value.folder;
}

export async function writeNewFile(path, contents) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeFolderSetting(path, folder) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, "folder-" + randomUUID() + ".tmp");
  await writeNewFile(temporary, JSON.stringify({ folder }) + "\n");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readBackupFile(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIBRARY_FILE_BYTES)
      throw new Error("备份需要普通文件，大小不能超过 132 MiB。");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size)
      throw new Error("备份文件在读取过程中发生变化，请重新选择。");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    await file.close();
  }
}
