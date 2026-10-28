import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineOperation, type AnyOperation } from '../../../src/operations/types';
import { booleanParam, enumParam, numberParam } from '../../../src/schemas/coerce';

// 引擎测试用的假操作：不依赖 ffmpeg，只验证 HTTP、队列、进度、存储和清理

function waitForAbort(signal: AbortSignal, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('等待取消超时')), timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 被取消或失败的操作已经分配过的产物路径，测试据此断言它们被删除 */
export const allocatedBy = new Map<string, string[]>();

export const copyOp = defineOperation({
  name: 'test-copy',
  route: '/api/test/copy',
  title: '测试复制',
  description: '把输入文件复制成产物',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '输入视频' }],
  params: z.object({
    repeat: numberParam('repeat', { min: 1, max: 3, int: true })
      .default(1)
      .meta({ description: '复制几份' }),
    label: z.string().max(20).optional().meta({ description: '标签' }),
  }),
  chainable: true,
  async run(ctx, params) {
    const src = ctx.inputs.file[0];
    const files: string[] = [];
    for (let i = 0; i < params.repeat; i++) {
      const out = ctx.outputPath('mp4');
      await fs.promises.copyFile(src, out);
      files.push(out);
      ctx.progress((i + 1) / params.repeat, { phase: 'encoding' });
    }
    const size = (await fs.promises.stat(src)).size;
    return { files, data: { size, inputName: path.basename(src), label: params.label ?? null } };
  },
});

export const multiOp = defineOperation({
  name: 'test-multi',
  route: '/api/test/multi',
  title: '测试多文件',
  description: '把多个输入拼成一个文件',
  inputs: [
    {
      name: 'files',
      kind: 'media',
      required: true,
      multiple: { min: 2, max: 3 },
      description: '2-3 个文件',
    },
    { name: 'image', kind: 'image', required: false, description: '可选图片' },
  ],
  params: z.object({}),
  async run(ctx) {
    const out = ctx.outputPath('bin');
    const parts = await Promise.all(ctx.inputs.files.map((f) => fs.promises.readFile(f)));
    await fs.promises.writeFile(out, Buffer.concat(parts));
    return { files: [out], data: { count: parts.length, hasImage: Boolean(ctx.inputs.image) } };
  },
});

export const dirOp = defineOperation({
  name: 'test-dir',
  route: '/api/test/dir',
  title: '测试多文件产物',
  description: '在子目录里生成两个文件',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const dir = await ctx.outputDir();
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'index.m3u8');
    await fs.promises.writeFile(a, 'a');
    await fs.promises.writeFile(b, '#EXTM3U\n');
    return { files: [a, b], primary: b };
  },
});

export const syncOp = defineOperation({
  name: 'test-sync',
  route: '/api/test/sync',
  title: '测试同步',
  description: '同步返回输入大小',
  sync: true,
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({
    mode: enumParam('mode', ['fast', 'slow']).default('fast').meta({ description: '模式' }),
  }),
  async run(ctx, params) {
    // 同步接口的产物会被引擎删掉，这里故意分配一个验证清理
    const stray = ctx.outputPath('txt');
    await fs.promises.writeFile(stray, 'stray');
    allocatedBy.set('test-sync', [stray]);
    if (params.mode === 'slow') await waitForAbort(ctx.signal, 10_000);
    const size = (await fs.promises.stat(ctx.inputs.file[0])).size;
    return { files: [], data: { size } };
  },
});

export const failOp = defineOperation({
  name: 'test-fail',
  route: '/api/test/fail',
  title: '测试失败',
  description: '写了一半产物后失败',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const out = ctx.outputPath('mp4');
    await fs.promises.writeFile(out, 'partial');
    const dir = await ctx.outputDir();
    await fs.promises.writeFile(path.join(dir, 'seg0.ts'), 'x');
    allocatedBy.set(ctx.taskId, [out, dir]);
    throw new Error('故意失败');
  },
});

export const waitOp = defineOperation({
  name: 'test-wait',
  route: '/api/test/wait',
  title: '测试等待',
  description: '一直运行直到被取消',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const out = ctx.outputPath('mp4');
    await fs.promises.writeFile(out, 'partial');
    allocatedBy.set(ctx.taskId, [out]);
    ctx.progress(0.5);
    return waitForAbort(ctx.signal, 10_000);
  },
});

export const escapeOp = defineOperation({
  name: 'test-escape',
  route: '/api/test/escape',
  title: '测试越界产物',
  description: '返回输出目录之外的文件',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    return { files: [ctx.inputs.file[0]] };
  },
});

export const checkOp = defineOperation({
  name: 'test-check',
  route: '/api/test/check',
  title: '测试跨字段校验',
  description: 'start 必须小于 end，且有字幕时 burn 才能为 true',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '视频' },
    { name: 'subtitle', kind: 'subtitle', required: false, description: '字幕' },
  ],
  params: z.object({
    start: numberParam('start', { min: 0 }).default(0).meta({ description: '开始' }),
    end: numberParam('end', { min: 0 }).optional().meta({ description: '结束' }),
  }),
  check(params, provided) {
    if (params.end !== undefined && params.end <= params.start) return 'end 必须大于 start';
    if (provided.subtitle === 0 && params.start > 100) return '没有字幕时 start 不能超过 100';
    return undefined;
  },
  async run(ctx) {
    const out = ctx.outputPath('mp4');
    await fs.promises.copyFile(ctx.inputs.file[0], out);
    return { files: [out], data: { subtitle: Boolean(ctx.inputs.subtitle) } };
  },
});

/** 名字对应旧版 gif 任务的假操作，测试升级前留在 Redis 里的 job */
export const legacyGifOp = defineOperation({
  name: 'test-legacy-gif',
  route: '/api/test/legacy-gif',
  title: '测试旧版任务',
  description: '旧版 job 映射',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '视频' },
    { name: 'image', kind: 'image', required: false, description: '水印图' },
  ],
  params: z.object({
    width: numberParam('width', { min: 16, max: 1920, int: true })
      .default(320)
      .meta({ description: '宽' }),
    format: enumParam('format', ['gif', 'webp']).default('gif').meta({ description: '格式' }),
  }),
  async run(ctx, params) {
    const out = ctx.outputPath(params.format);
    await fs.promises.copyFile(ctx.inputs.file[0], out);
    return { files: [out], data: { width: params.width, hasImage: Boolean(ctx.inputs.image) } };
  },
});

export const legacyComposeOp = defineOperation({
  name: 'test-legacy-compose',
  route: '/api/test/legacy-compose',
  title: '测试旧版合成',
  description: '旧版 compose job 映射（链接输入）',
  downloadShare: 0.55,
  inputs: [
    {
      name: 'videos',
      kind: 'video',
      required: true,
      multiple: { min: 1, max: 5 },
      urlFields: ['videos'],
      description: '视频链接',
    },
    { name: 'music', kind: 'audio', required: false, urlFields: ['music'], description: '音乐' },
  ],
  params: z.object({
    musicVolume: numberParam('musicVolume', { min: 0, max: 1 })
      .default(1)
      .meta({ description: '音量' }),
  }),
  async run(ctx, params) {
    const out = ctx.outputPath('mp4');
    const parts = await Promise.all(ctx.inputs.videos.map((f) => fs.promises.readFile(f)));
    await fs.promises.writeFile(out, Buffer.concat(parts));
    return {
      files: [out],
      data: { videos: parts.length, music: Boolean(ctx.inputs.music), volume: params.musicVolume },
    };
  },
});

/** test-stamp 每次执行看到的输入、工作目录和产物，测试据此断言中间产物的位置和清理 */
export const stampLog = new Map<string, { input: string; workDir: string; output: string }[]>();

/** 可串联：输出 = 输入内容 + |tag（有 image 时再加 +图片字节数），pipeline 的最终产物能看出经过了哪些步骤 */
export const stampOp = defineOperation({
  name: 'test-stamp',
  route: '/api/test/stamp',
  title: '测试盖章',
  description: '在输入内容后追加标记',
  inputs: [
    { name: 'file', kind: 'any', required: true, description: '任意输入' },
    { name: 'image', kind: 'image', required: false, description: '可选图片' },
  ],
  params: z.object({
    tag: z
      .string()
      .regex(/^[a-z0-9]{1,8}$/, { error: 'tag 只能是 1-8 位小写字母或数字' })
      .default('x')
      .meta({ description: '标记' }),
    progress: booleanParam('progress').default(false).meta({ description: '汇报中途进度' }),
  }),
  chainable: true,
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const content = await fs.promises.readFile(input, 'utf8');
    const image = ctx.inputs.image ? `+${(await fs.promises.stat(ctx.inputs.image[0])).size}` : '';
    if (params.progress) ctx.progress(0.5, { phase: 'encoding' });
    const out = ctx.outputPath('txt');
    await fs.promises.writeFile(out, `${content}|${params.tag}${image}`);
    const log = stampLog.get(ctx.taskId) ?? [];
    log.push({ input, workDir: ctx.workDir, output: out });
    stampLog.set(ctx.taskId, log);
    return { files: [out], data: { tag: params.tag } };
  },
});

/** 只返回数据、不产出文件的分析类操作 */
export const dataOp = defineOperation({
  name: 'test-data',
  route: '/api/test/data',
  title: '测试分析',
  description: '只返回数据',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const size = (await fs.promises.stat(ctx.inputs.file[0])).size;
    return { files: [], data: { size } };
  },
});

/** 必填附加输入的可串联操作（像 video.mix-audio），pipeline 里必须在 inputs 里给链接 */
export const needsOp = defineOperation({
  name: 'test-needs',
  route: '/api/test/needs',
  title: '测试必填附加输入',
  description: '需要 file 和 extra',
  inputs: [
    { name: 'file', kind: 'any', required: true, description: '任意输入' },
    {
      name: 'extra',
      kind: 'any',
      required: true,
      multiple: { min: 1, max: 2 },
      description: '1-2 个附加文件',
    },
  ],
  params: z.object({}),
  chainable: true,
  async run(ctx) {
    const out = ctx.outputPath('txt');
    const content = await fs.promises.readFile(ctx.inputs.file[0], 'utf8');
    await fs.promises.writeFile(out, `${content}|extra${ctx.inputs.extra.length}`);
    return { files: [out] };
  },
});

export const allOps: AnyOperation[] = [
  copyOp,
  multiOp,
  dirOp,
  syncOp,
  failOp,
  waitOp,
  escapeOp,
  checkOp,
  legacyGifOp,
  legacyComposeOp,
];

export const pipelineOps: AnyOperation[] = [...allOps, stampOp, dataOp, needsOp];
