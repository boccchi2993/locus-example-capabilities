// SO1–SO3：2026-10-28 store-only 迁移（product PR #45，writeLocusArchive
// 一律 method 0）的内容不变性证明。
//
//   SO1  升级后构建的 .locus 每个条目都是 store（method 0）；
//   SO2  manifest digest 与升级前（deflate 版 writer）构建的 digest
//        逐位相同——升级前基准（2026-10-28 用旧锁 29ebaad 记录）：
//          charts       3c664dc618db7595386f74fe2bcd7c892b9a182963b90870bd5d11ddc03da0be
//          deepseek-web 65fc6f1bc816e4e00dea0ea639c765eca3bcf4958296974c49e7eb7b4b8a6735
//        digest 只取决于包文件内容 + 身份字段 + locus.json，与容器压缩
//        方式无关，必须恒等；
//   SO3  包字节确实变了（store 版 sha256 与 deflate 版不同）——证明
//        迁移真实发生，不是空跑。
//
// 运行：node tests/store-only.test.mjs（npm test 会依次跑全部）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCapability, capabilitiesDir, listCapabilityIds } from '../scripts/build.mjs';
import { readLocusArchive, parseLocusMd, manifestDigest } from 'locus-browser-agent-runtime/src/locus-archive.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}

const PRE_UPGRADE_DIGESTS = {
  'charts': '3c664dc618db7595386f74fe2bcd7c892b9a182963b90870bd5d11ddc03da0be',
  'deepseek-web': '65fc6f1bc816e4e00dea0ea639c765eca3bcf4958296974c49e7eb7b4b8a6735',
};
// 升级前（deflate）构建的包 sha256，仅用于 SO3 的“字节确实变了”。
const PRE_UPGRADE_ARCHIVE_SHA256 = {
  'charts': '130ee9074c5b21c18f1b6ef539957e7ae38f42d97579f920ff4b064037c0e85c',
  'deepseek-web': 'c5e5ebbfa9b6ec29456a29fe02f7a3a01de12b83315be8e3ca0cfcd3c7652447',
};

// 极小 central-directory 解析：只需 method 字段（offset+10，2 字节）。
function archiveEntryMethods(bytes) {
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32 = (o) => bytes.readUInt32LE(o);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (u32(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip');
  const total = u16(eocd + 10);
  let off = u32(eocd + 16);
  const methods = [];
  for (let i = 0; i < total; i++) {
    if (u32(off) !== 0x02014b50) throw new Error('central directory 损坏');
    methods.push(u16(off + 10));
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return methods;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

for (const id of listCapabilityIds()) {
  if (!(id in PRE_UPGRADE_DIGESTS)) continue; // 基准只覆盖升级时存在的两个能力
  const built = await buildCapability(path.join(capabilitiesDir, id));

  const methods = archiveEntryMethods(Buffer.from(built.bytes));
  check('SO1 ' + id + ' 全部条目 store（method 0）',
    methods.length > 0 && methods.every((m) => m === 0), JSON.stringify(methods));

  const read = await readLocusArchive(Buffer.from(built.bytes));
  const parsed = read.ok ? parseLocusMd(read.locusMd) : null;
  const digest = parsed && parsed.ok ? await manifestDigest(parsed.manifest) : null;
  check('SO2 ' + id + ' manifest digest 与升级前一致',
    digest === PRE_UPGRADE_DIGESTS[id],
    'now ' + digest + ' / pre ' + PRE_UPGRADE_DIGESTS[id]);
  check('SO2 ' + id + ' 构建内 manifest 与包内 manifest digest 一致',
    digest !== null && (await manifestDigest(built.manifest)) === digest);

  const nowSha = sha256(Buffer.from(built.bytes));
  check('SO3 ' + id + ' 包字节与 deflate 版不同（迁移真实发生）',
    nowSha !== PRE_UPGRADE_ARCHIVE_SHA256[id], nowSha);
}

console.log('store-only.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
