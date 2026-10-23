// ============================================================
//  BUILD — 每个 capabilities/<id>/ 目录构建为一个确定性的
//  dist/<id>-<version>.locus。
//
//  打包管线只用 locus-product（以 locus-browser-agent-runtime 安装）
//  的现有模块，不复制任何打包算法：
//
//    读目录 -> createMemoryWorkspace -> buildProject（校验 + lock）
//    -> expectedPackagePaths(lock) 读回包文件
//    -> repinManifest 生成 locus-manifest（files 清单 + sha256）
//    -> renderLocusMd -> writeLocusArchive
//
//  用法：
//    node scripts/build.mjs [<id> ...]   # 不带参数时构建 capabilities/ 全部
//
//  确定性：同样的输入两次构建字节完全相同。writeLocusArchive 使用固定
//  DOS 时间戳、按路径排序、canonical JSON（ locus-product/src/locus-archive.js
//  ），manifest 与 LOCUS.md 正文不含任何时间戳——时间是构建输入
//  （locus.json），不是构建时的时钟。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildProject } from 'locus-browser-agent-runtime/src/capability-package.js';
import {
  LOCUS_LIMITS,
  expectedPackagePaths,
  repinManifest,
  renderLocusMd,
  writeLocusArchive,
} from 'locus-browser-agent-runtime/src/locus-archive.js';
import { createMemoryWorkspace } from 'locus-browser-agent-runtime/src/product/runtime-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const capabilitiesDir = path.join(repoRoot, 'capabilities');
export const distDir = path.join(repoRoot, 'dist');

const LOCUS_JSON_NAME = 'locus.json'; // 能力目录的元文件，不进包

export function listCapabilityIds(rootDir = capabilitiesDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// locus.json: { author, purpose, changelog: [...], title }
// author / purpose 进 manifest（与 packLocus 相同的长度上限），title 与
// changelog 渲染进 LOCUS.md 正文。
function readLocusJson(sourceDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(sourceDir, LOCUS_JSON_NAME), 'utf8'));
  for (const field of ['title', 'author', 'purpose']) {
    if (typeof meta[field] !== 'string' || !meta[field].length) {
      throw new Error(sourceDir + ': ' + LOCUS_JSON_NAME + ' 缺少字符串字段 "' + field + '"');
    }
  }
  if (!Array.isArray(meta.changelog) || !meta.changelog.length
    || meta.changelog.some((l) => typeof l !== 'string' || !l.length)) {
    throw new Error(sourceDir + ': ' + LOCUS_JSON_NAME + ' 的 "changelog" 必须是非空字符串数组');
  }
  if (meta.author.length > 200) {
    throw new Error(sourceDir + ': author 超过 200 字符上限');
  }
  if (meta.purpose.length > 2000) {
    throw new Error(sourceDir + ': purpose 超过 2000 字符上限');
  }
  return meta;
}

function renderLocusBody(meta) {
  const lines = [];
  lines.push('# ' + meta.title);
  lines.push('');
  lines.push(meta.purpose);
  lines.push('');
  lines.push('## 更改记录');
  lines.push('');
  for (const entry of meta.changelog) lines.push('- ' + entry);
  lines.push('');
  return lines.join('\n');
}

// 把能力目录（除 locus.json 外的全部文件）收进内存工作区。相对路径一律
// 转成 POSIX "/"——工作区只认 POSIX 相对路径。
function collectPackageFiles(sourceDir, workspace) {
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const relPosix = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPosix);
      } else if (entry.isFile()) {
        if (!rel && entry.name === LOCUS_JSON_NAME) continue; // 元文件不进包
        workspace.write(relPosix, fs.readFileSync(abs));
      }
    }
  };
  walk(sourceDir, '');
}

// 构建一个能力目录 -> { id, version, bytes, manifest }。
// sourceDir 必须直接包含 capability.json 与 locus.json。
export async function buildCapability(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, 'capability.json'))) {
    throw new Error(sourceDir + ': 缺少 capability.json，不是一个能力目录');
  }
  const meta = readLocusJson(sourceDir);

  const workspace = createMemoryWorkspace({
    maxBytes: LOCUS_LIMITS.maxTotalBytes,
    maxFileBytes: LOCUS_LIMITS.maxFileBytes,
  });
  collectPackageFiles(sourceDir, workspace);

  const built = await buildProject({ workspace, root: '' });
  if (!built.ok) {
    const detail = built.diagnostics.map((d) => d.code + (d.path ? ' at ' + d.path : '')).join('; ');
    throw new Error(sourceDir + ': buildProject 校验失败: ' + detail);
  }
  const lock = built.bundle.lock;

  // 包文件 = 能力清单 + 全部声明的运行时文件（closed set）。
  const files = new Map();
  for (const rel of expectedPackagePaths(lock)) {
    files.set(rel, await workspace.readBytes(rel));
  }

  const manifest = await repinManifest({
    schemaVersion: 1,
    id: lock.capability.id,
    version: lock.capability.version,
    author: meta.author,
    purpose: meta.purpose,
  }, files);

  const locusMd = renderLocusMd({ body: renderLocusBody(meta), manifest });
  const bytes = await writeLocusArchive(files, locusMd);
  return { id: manifest.id, version: manifest.version, bytes, manifest };
}

async function main(argv) {
  const ids = argv.length ? argv : listCapabilityIds();
  if (!ids.length) {
    console.log('no capabilities');
    return 0;
  }
  fs.mkdirSync(distDir, { recursive: true });
  for (const id of ids) {
    const built = await buildCapability(path.join(capabilitiesDir, id));
    const out = path.join(distDir, built.id + '-' + built.version + '.locus');
    fs.writeFileSync(out, built.bytes);
    console.log(built.id + '@' + built.version + ' -> ' + path.relative(repoRoot, out)
      + ' (' + built.bytes.byteLength + ' bytes)');
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error('build failed: ' + (e && e.message ? e.message : String(e)));
      process.exit(1);
    },
  );
}
