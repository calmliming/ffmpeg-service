/**
 * 从操作注册表生成接口参考，写进文档里 <!-- BEGIN GENERATED: xxx --> 和 <!-- END GENERATED: xxx --> 之间。
 * 参数表来自各操作 zod schema 的 .meta() 说明，和 GET /api/operations 返回的是同一份数据，改了操作后重新运行：
 *   pnpm docs:api
 */
import fs from 'node:fs';
import path from 'node:path';
import { describeOperation, type JsonSchema, type OperationInfo } from '../src/core/catalog';
import type { AnyOperation } from '../src/operations/types';
import { operations as basic } from '../src/operations/basic';
import { operations as visual } from '../src/operations/visual';
import { operations as geometry } from '../src/operations/geometry';
import { operations as timeline } from '../src/operations/timeline';
import { operations as effects } from '../src/operations/effects';
import { operations as compositing } from '../src/operations/compositing';
import { operations as audio } from '../src/operations/audio';
import { operations as analysis } from '../src/operations/analysis';

const GROUPS: { title: string; ops: readonly AnyOperation[] }[] = [
  { title: '基础接口（兼容旧版）', ops: basic },
  { title: '截图、水印与合成', ops: visual },
  { title: '画面尺寸与布局', ops: geometry },
  { title: '时间线剪辑', ops: timeline },
  { title: '画面特效与压缩', ops: effects },
  { title: '字幕、配乐与生成视频', ops: compositing },
  { title: '音频处理', ops: audio },
  { title: '分析、流媒体与图片', ops: analysis },
];

const KIND_TEXT: Record<string, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  subtitle: '字幕（srt / ass / ssa / vtt）',
  media: '视频或音频',
  any: '视频、音频或图片',
};

const anchor = (name: string) => `op-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
// 表格单元格里不能有竖线和换行
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const code = (value: unknown) => `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;

function typeText(schema: JsonSchema): string {
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (variants) return [...new Set(variants.map(typeText))].join(' 或 ');
  const type = schema.type;
  if (type === 'array') {
    const items = schema.items as JsonSchema | undefined;
    return items ? `${typeText(items)} 数组` : '数组';
  }
  const names: Record<string, string> = {
    string: '字符串',
    integer: '整数',
    number: '数字',
    boolean: '布尔',
    object: '对象',
  };
  return typeof type === 'string' ? (names[type] ?? type) : '任意';
}

function constraintText(schema: JsonSchema): string {
  const parts: string[] = [];
  const description = typeof schema.description === 'string' ? schema.description : '';
  // 说明里已经逐个列出取值时不再重复
  if (Array.isArray(schema.enum) && !schema.enum.every((v) => description.includes(String(v)))) {
    parts.push(`可选 ${schema.enum.map(code).join(' / ')}`);
  }
  const min = schema.minimum ?? schema.exclusiveMinimum;
  const max = schema.maximum ?? schema.exclusiveMaximum;
  if (min !== undefined && max !== undefined) parts.push(`范围 ${min} ~ ${max}`);
  else if (min !== undefined) parts.push(`最小 ${min}`);
  else if (max !== undefined) parts.push(`最大 ${max}`);
  if (schema.type === 'array') {
    if (schema.minItems !== undefined || schema.maxItems !== undefined) {
      parts.push(`${schema.minItems ?? 0} ~ ${schema.maxItems ?? '不限'} 项`);
    }
  }
  if (schema.maxLength !== undefined) parts.push(`最长 ${schema.maxLength} 字符`);
  return parts.join('；');
}

function paramsTable(params: JsonSchema | undefined): string {
  const properties = (params?.properties ?? {}) as Record<string, JsonSchema>;
  const names = Object.keys(properties);
  if (!names.length) return '无参数。\n';
  const required = new Set((params?.required as string[] | undefined) ?? []);
  const rows = names.map((name) => {
    const schema = properties[name];
    // 有默认值的字段在 output 模式的 schema 里也会被列为 required，对调用方来说它是可选的
    const mustSend = required.has(name) && schema.default === undefined;
    const extra = constraintText(schema);
    const description = [schema.description as string | undefined, extra]
      .filter(Boolean)
      .join('。');
    return `| \`${name}\` | ${typeText(schema)} | ${mustSend ? '是' : '否'} | ${
      schema.default === undefined ? '' : code(schema.default)
    } | ${cell(description)} |`;
  });
  return [
    '| 参数 | 类型 | 必填 | 默认值 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function inputsTable(info: OperationInfo): string {
  const rows = info.inputs.map((input) => {
    const count = input.multiple ? `${input.multiple.min} ~ ${input.multiple.max} 个` : '1 个';
    const urls = input.urlFields.map((f) => `\`${f}\``).join('、');
    return `| \`${input.name}\` | ${KIND_TEXT[input.kind] ?? input.kind} | ${
      input.required ? '是' : '否'
    } | ${count} | ${urls} | ${cell(input.description)} |`;
  });
  return [
    '| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function renderOperation(op: AnyOperation): string {
  const info = describeOperation(op);
  const tags = [
    info.sync ? '同步返回结果' : '异步任务',
    info.chainable ? '可在 pipeline 中串联' : '',
  ].filter(Boolean);
  const lines = [
    `<a id="${anchor(info.name)}"></a>`,
    '',
    `#### ${info.title}`,
    '',
    `\`POST ${info.route}\` · 操作名 \`${info.name}\` · ${tags.join(' · ')}`,
    '',
    info.description,
    '',
    '**输入文件**',
    '',
    inputsTable(info),
    '',
    '**参数**',
    '',
    paramsTable(info.params),
  ];
  if (info.notes?.length) {
    lines.push('', '**说明**', '', ...info.notes.map((note) => `- ${note}`));
  }
  if (info.example) lines.push('', '```bash', info.example.trim(), '```');
  return lines.join('\n');
}

function renderReference(): string {
  const parts: string[] = [];
  for (const group of GROUPS) {
    parts.push(`### ${group.title}`, '');
    for (const op of group.ops) parts.push(renderOperation(op), '');
  }
  return parts.join('\n').trimEnd();
}

function renderIndex(target: string): string {
  const parts: string[] = [];
  for (const group of GROUPS) {
    parts.push(`**${group.title}**`, '', '| 接口 | 功能 | 串联 |', '| --- | --- | --- |');
    for (const op of group.ops) {
      const info = describeOperation(op);
      const link = target ? `${target}#${anchor(info.name)}` : `#${anchor(info.name)}`;
      parts.push(
        `| [\`${info.route}\`](${encodeURI(link)}) | ${cell(info.title)}${info.sync ? '（同步）' : ''} | ${info.chainable ? '✓' : ''} |`,
      );
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

function replaceBlock(content: string, name: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1) return content;
  return `${content.slice(0, start + begin.length)}\n${body}\n${content.slice(stop)}`;
}

const root = path.resolve(__dirname, '..');
const REFERENCE_DOC = 'Fmpeg API Documentation.md';
const targets: { file: string; blocks: Record<string, () => string> }[] = [
  {
    file: 'README.md',
    blocks: { 'operation-index': () => renderIndex(REFERENCE_DOC) },
  },
  {
    file: REFERENCE_DOC,
    blocks: {
      'operation-index': () => renderIndex(''),
      'operation-reference': renderReference,
    },
  },
];

const check = process.argv.includes('--check');
let stale = false;
for (const target of targets) {
  const file = path.join(root, target.file);
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let content = original.replace(/\r\n/g, '\n');
  for (const [name, render] of Object.entries(target.blocks)) {
    content = replaceBlock(content, name, render());
  }
  content = content.replace(/\n/g, eol);
  if (content === original) continue;
  stale = true;
  if (check) console.error(`${target.file} 的生成内容已过期，请运行 pnpm docs:api`);
  else {
    fs.writeFileSync(file, content);
    console.log(`已更新 ${target.file}`);
  }
}
if (check && stale) process.exit(1);
