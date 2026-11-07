import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const saltSize = 16;
const nonceSize = 12;
const tagSize = 16;
const magic = Buffer.from("Memory Galaxy encrypted backup\x00\x01", "ascii");
const cipherName = "aes-256-gcm";
const parameters = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 ** 2 };
export const ENCRYPTED_RECORD_OVERHEAD = nonceSize + tagSize;
export const ENCRYPTED_BACKUP_OVERHEAD =
  magic.length + saltSize + ENCRYPTED_RECORD_OVERHEAD;

function seal(key, content, context) {
  const nonce = randomBytes(nonceSize);
  const cipher = createCipheriv(cipherName, key, nonce, {
    authTagLength: tagSize,
  });
  cipher.setAAD(context);
  const ciphertext = cipher.update(content);
  return Buffer.concat([
    nonce,
    cipher.final(),
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

function unseal(key, content, context) {
  if (content.length < nonceSize + tagSize) throw new Error("加密文件不完整。");
  const cipher = createDecipheriv(
    cipherName,
    key,
    content.subarray(0, nonceSize),
    {
      authTagLength: tagSize,
    },
  );
  cipher.setAAD(context);
  cipher.setAuthTag(content.subarray(nonceSize, nonceSize + tagSize));
  const plaintext = cipher.update(content.subarray(nonceSize + tagSize));
  try {
    cipher.final();
    return plaintext;
  } catch {
    plaintext.fill(0);
    throw new Error("密码不正确，或加密数据已损坏。");
  }
}

class Encryption {
  #key;
  constructor(key, salt) {
    this.#key = key;
    this.salt = salt;
  }
  copy() {
    return new Encryption(Buffer.from(this.#key), this.salt);
  }
  dispose() {
    this.#key.fill(0);
  }
  recordId(kind, id) {
    return id
      ? createHmac("sha256", this.#key.subarray(32, 64))
          .update(kind + "\0" + id)
          .digest("hex")
      : id;
  }
  sealRecord(kind, id, content) {
    return seal(
      this.#key.subarray(0, 32),
      content,
      Buffer.from("record\0" + kind + "\0" + id),
    );
  }
  openRecord(kind, id, content) {
    return unseal(
      this.#key.subarray(0, 32),
      content,
      Buffer.from("record\0" + kind + "\0" + id),
    );
  }
  sealBackup(text) {
    const header = Buffer.concat([magic, Buffer.from(this.salt, "hex")]);
    const data = Buffer.from(text);
    try {
      return Buffer.concat([
        header,
        seal(this.#key.subarray(64), data, header),
      ]);
    } finally {
      data.fill(0);
    }
  }
  openBackup(bytes) {
    const end = magic.length + saltSize;
    const data = unseal(
      this.#key.subarray(64),
      bytes.subarray(end),
      bytes.subarray(0, end),
    );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } finally {
      data.fill(0);
    }
  }
}

export async function deriveEncryption(
  password,
  salt = randomBytes(saltSize).toString("hex"),
) {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) > 1024 ||
    [...password].length < 12
  )
    throw new Error("请输入至少 12 个字符、最多 1024 字节的密码。");
  if (typeof salt !== "string" || !/^[a-f0-9]{32}$/.test(salt))
    throw new Error("加密资料库的头部损坏。");
  const secret = Buffer.from(password);
  try {
    return new Encryption(
      await derive(secret, Buffer.from(salt, "hex"), 96, parameters),
      salt,
    );
  } finally {
    secret.fill(0);
  }
}

export function isEncryptedBackup(bytes) {
  return bytes.subarray(0, magic.length).equals(magic);
}

export async function decryptBackup(bytes, password) {
  if (!isEncryptedBackup(bytes) || bytes.length <= ENCRYPTED_BACKUP_OVERHEAD)
    throw new Error("加密备份格式不支持或文件不完整。");
  const salt = bytes
    .subarray(magic.length, magic.length + saltSize)
    .toString("hex");
  const encryption = await deriveEncryption(password, salt);
  try {
    return encryption.openBackup(bytes);
  } finally {
    encryption.dispose();
  }
}
