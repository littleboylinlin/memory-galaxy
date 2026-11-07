import { constants } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
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

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function stageFile(path, write, publish) {
  const directory = await mkdtemp(join(dirname(path), ".memory-galaxy-"));
  try {
    const staged = join(directory, "staged");
    await write(staged);
    return await publish(staged, path);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function publishNewFile(staged, path) {
  try {
    // A link exposes the completed file and refuses to replace a file created by a competing writer.
    await link(staged, path);
  } catch (error) {
    if (
      ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"].includes(
        error.code,
      )
    )
      throw new Error(
        "该文件系统无法安全发布新文件，请选择支持硬链接的本地磁盘。",
        { cause: error },
      );
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function writeAndSync(path, contents) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function writeNewFile(path, contents) {
  return stageFile(
    path,
    (staged) => writeAndSync(staged, contents),
    publishNewFile,
  );
}

export async function writeFolderSetting(path, folder) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  return stageFile(
    path,
    (staged) => writeAndSync(staged, JSON.stringify({ folder }) + "\n"),
    async (staged) => {
      await rename(staged, path);
      // Rename has already changed the setting. Report a durability warning separately.
      return syncDirectory(directory).then(
        () => true,
        () => false,
      );
    },
  );
}

export async function readBackupBytes(path, maxBytes = LIBRARY_FILE_BYTES) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("备份必须是普通文件，且不能超过支持的大小。");
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
    const after = await file.stat();
    if (
      offset !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("备份文件在读取过程中发生变化，请重新选择。");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export async function readBackupFile(path) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBackupBytes(path),
  );
}
