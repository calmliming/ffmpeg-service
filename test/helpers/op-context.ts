import fs from 'node:fs';
import path from 'node:path';
import { createOperationContext, type CreatedContext } from '../../src/core/context';
import { normalizeRawParams } from '../../src/core/params';
import type { AnyOperation, OperationResult, ProgressExtra } from '../../src/operations/types';
import { makeTempDir } from './media';

export interface TestContext extends CreatedContext {
  /** 每次 ctx.progress 收到的 fraction（已截到 0-1） */
  readonly progressCalls: { fraction: number; extra?: ProgressExtra }[];
  readonly logs: string[];
  /** 本次测试的产物目录（代替 config.outputDir） */
  readonly outputRoot: string;
  cleanup(): Promise<void>;
}

/** 创建一个真实的执行上下文：独立的临时 workDir 和产物目录，测试结束调用 cleanup() */
export function createTestContext(
  inputs: Record<string, string[]>,
  opts: { signal?: AbortSignal; taskId?: string } = {},
): TestContext {
  const root = makeTempDir('ffsvc-op-');
  const workDir = path.join(root, 'work');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(workDir);
  fs.mkdirSync(outputRoot);
  const progressCalls: { fraction: number; extra?: ProgressExtra }[] = [];
  const logs: string[] = [];
  const ctx = createOperationContext({
    taskId: opts.taskId ?? 'test-task',
    inputs,
    workDir,
    outputRoot,
    signal: opts.signal ?? new AbortController().signal,
    onProgress: (fraction, extra) => progressCalls.push({ fraction, extra }),
    onLog: (message) => logs.push(message),
  });
  return Object.assign(ctx, {
    progressCalls,
    logs,
    outputRoot,
    // Windows 上 ffmpeg / ffprobe 刚退出时文件句柄可能还没释放，直接删会 EBUSY / EPERM
    cleanup: () =>
      fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  });
}

/**
 * 按引擎的方式跑一个操作：先用 op.params 解析原始参数（字符串形式也可以），再跑 op.check，最后 run。
 * 参数不合法时抛出带中文信息的错误，便于断言
 */
export async function runOperation(
  op: AnyOperation,
  inputs: Record<string, string[]>,
  rawParams: Record<string, unknown> = {},
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: OperationResult; ctx: TestContext }> {
  const parsed = op.params.safeParse(normalizeRawParams(rawParams));
  if (!parsed.success) {
    throw new Error(`参数校验失败: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
  }
  const provided = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.length]));
  const problem = op.check?.(parsed.data, provided);
  if (problem) throw new Error(`参数校验失败: ${problem}`);
  const ctx = createTestContext(inputs, opts);
  try {
    const result = await op.run(ctx, parsed.data);
    return { result, ctx };
  } catch (err) {
    // 预期失败的用例拿不到 ctx，在这里清理，否则每个 assert.rejects 都在临时目录留一份
    await ctx.cleanup().catch(() => {});
    throw err;
  }
}

/** 参数校验应当失败：返回所有错误信息，便于断言 400 场景 */
export function paramErrors(
  op: AnyOperation,
  rawParams: Record<string, unknown>,
  provided: Record<string, number> = { file: 1 },
): string[] {
  const parsed = op.params.safeParse(normalizeRawParams(rawParams));
  if (!parsed.success) return parsed.error.issues.map((i) => i.message);
  const problem = op.check?.(parsed.data, provided);
  return problem ? [problem] : [];
}
