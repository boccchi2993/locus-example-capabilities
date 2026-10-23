// ============================================================
//  SKILL 规范检查 — 对一个能力目录下所有 SKILL.md 强制：
//
//    1. 不出现字面 API key：`sk-` 后跟 16 个以上字母数字。
//    2. 每条 curl 命令里出现的 $NAME 形式变量，NAME 必须在该能力
//       capability.json 的 credentials 中声明过。
//    3. 使用了凭据变量的 curl，其目标 URL 必须以对应凭据的
//       origin + pathPrefix 开头（凭据只能发往声明的作用域）。
//
//  返回违规列表 [{ file, rule, message }]；空数组 = 通过。
//  check.mjs 与测试套件共用本模块。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

const LITERAL_KEY_PATTERN = /sk-[A-Za-z0-9]{16,}/;
const VAR_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
const URL_PATTERN = /https?:\/\/[^\s'"`<>]+/;

function walkSkillMdFiles(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    const relPosix = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walkSkillMdFiles(abs, relPosix, out);
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push({ abs, rel: relPosix });
  }
  return out;
}

// 一条 curl 命令 = 含 curl 的那一行，加上续行反斜杠带来的后续行。
export function extractCurlCommands(text) {
  const lines = text.split('\n');
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcurl\b/.test(lines[i])) continue;
    let cmd = lines[i];
    while (cmd.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      cmd = cmd.trimEnd().slice(0, -1) + ' ' + lines[++i].trim();
    }
    commands.push(cmd);
  }
  return commands;
}

function targetUrlOf(cmd) {
  const m = cmd.match(URL_PATTERN);
  if (!m) return null;
  return m[0].replace(/[),.;:'"]+$/, '');
}

export function checkSkillSpecs(capabilityDir) {
  const violations = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(capabilityDir, 'capability.json'), 'utf8'));
  const credentials = Array.isArray(manifest.capability && manifest.capability.credentials)
    ? manifest.capability.credentials
    : [];

  for (const { abs, rel } of walkSkillMdFiles(capabilityDir, '', [])) {
    const text = fs.readFileSync(abs, 'utf8');
    const at = capabilityDir + '/' + rel;

    if (LITERAL_KEY_PATTERN.test(text)) {
      violations.push({
        file: at,
        rule: 'literal-key',
        message: at + ' 出现 sk- 字面密钥（sk- 后 16 个以上字母数字）',
      });
    }

    for (const cmd of extractCurlCommands(text)) {
      const names = [...cmd.matchAll(VAR_PATTERN)].map((m) => m[1]);
      if (!names.length) continue;
      const url = targetUrlOf(cmd);
      for (const name of names) {
        const cred = credentials.find((c) => c && c.name === name);
        if (!cred) {
          violations.push({
            file: at,
            rule: 'undeclared-variable',
            message: at + ' 的 curl 使用了未在 capability.json credentials 中声明的变量 $' + name,
          });
          continue;
        }
        const prefix = cred.origin + cred.pathPrefix;
        if (!url || !url.startsWith(prefix)) {
          violations.push({
            file: at,
            rule: 'url-outside-prefix',
            message: at + ' 的 curl 目标 URL ' + JSON.stringify(url)
              + ' 不以凭据 ' + name + ' 的 ' + JSON.stringify(prefix) + ' 开头',
          });
        }
      }
    }
  }
  return violations;
}
