import type { Request } from 'express';
import { HttpError } from '../middleware/error';
import { isAllowedForKind, KIND_LABELS, uploadedFilesBySlot } from '../middleware/upload';
import { formatIssues } from '../middleware/validate';
import type { AnyOperation, InputSlot } from '../operations/types';
import type { PipelineStep } from '../types';
import {
  parseUrlList,
  rangeText,
  resolveRequestInputs,
  takeCallbackUrl,
  urlFieldsOf,
  type JobInputs,
} from './inputs';
import { normalizeRawParams } from './params';

/** pipeline 任务的 type 和 BullMQ job 名，操作不能用这个名字 */
export const PIPELINE_OP = 'pipeline';
export const PIPELINE_ROUTE = '/api/pipeline';
export const MAX_PIPELINE_STEPS = 10;

/** 队列里 pipeline 的一步：参数已校验；inputs 是 file 以外的附加输入（只能是链接） */
export interface PipelineStepPayload {
  op: string;
  params: Record<string, unknown>;
  inputs: JobInputs;
}

/**
 * pipeline 顶层的 file 槽。上传落盘时还没解析 steps（multipart 里 steps 字段可能在文件后面），
 * 先按 any 收，解析出第一步后再按第一步的 file 槽复查类型
 */
export const PIPELINE_FILE_SLOT: InputSlot = {
  name: 'file',
  kind: 'any',
  required: true,
  description: '第一步的输入文件',
};

/** 操作的单文件 file 槽；没有或是多文件槽时返回 undefined */
function fileSlotOf(op: AnyOperation): InputSlot | undefined {
  const slot = op.inputs.find((s) => s.name === 'file');
  return slot && !slot.multiple ? slot : undefined;
}

/** 操作能放在 pipeline 的哪些位置。规则见 stepProblem */
export interface PipelineRoles {
  first: boolean;
  middle: boolean;
  last: boolean;
}

export function pipelineRoles(op: AnyOperation): PipelineRoles {
  const accepts = !op.sync && fileSlotOf(op) !== undefined;
  return { first: accepts, middle: accepts && Boolean(op.chainable), last: accepts };
}

/**
 * 每一步都要能接收一个文件（异步操作、有单文件的 file 槽，其他必填槽在 inputs 里给链接）。
 * 要把产物交给下一步的中间步骤必须是 chainable（只产出一个主文件）；第一步沿用文档约定不限，
 * 最后一步的产物就是任务产物，HLS、抽帧、分析这类多文件或纯数据的操作也可以放在最后
 */
function stepProblem(op: AnyOperation, index: number, total: number): string | undefined {
  if (op.sync) return '是同步接口，不能用于 pipeline';
  if (!fileSlotOf(op)) return '没有单文件的 file 输入，不能用于 pipeline（多文件操作请单独调用）';
  const middle = index > 0 && index < total - 1;
  if (middle && !op.chainable) {
    return '不产出单个主文件（chainable=false），只能作为 pipeline 的第一步或最后一步';
  }
  return undefined;
}

export interface PreparedPipeline {
  /** 第一步的 file（上传或链接） */
  inputs: JobInputs;
  steps: PipelineStepPayload[];
  ops: AnyOperation[];
  /** 所有输入链接，入队前做 SSRF 检查 */
  urls: string[];
  callbackUrl?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseSteps(value: unknown): unknown[] {
  let steps = value;
  // multipart / urlencoded 表单里 steps 是 JSON 字符串
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch (err) {
      throw new HttpError(400, `steps 不是合法的 JSON: ${(err as Error).message}`);
    }
  }
  if (steps === undefined || steps === null) {
    throw new HttpError(400, '请提供 steps：要依次执行的步骤数组，如 [{"op":"trim","params":{…}}]');
  }
  if (!Array.isArray(steps)) throw new HttpError(400, 'steps 必须是数组');
  if (steps.length === 0) throw new HttpError(400, 'steps 至少需要 1 步');
  if (steps.length > MAX_PIPELINE_STEPS) {
    throw new HttpError(400, `steps 最多 ${MAX_PIPELINE_STEPS} 步，收到 ${steps.length} 步`);
  }
  return steps;
}

/** 一步的附加输入：{ 槽名: 链接 | 链接数组 }，file 由上一步提供 */
function parseStepInputs(
  op: AnyOperation,
  raw: unknown,
  where: string,
): { inputs: JobInputs; provided: Record<string, number> } {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new HttpError(400, `${where}: inputs 必须是对象，如 {"image": "https://…"}`);
  }
  const given = raw ?? {};
  const extraSlots = op.inputs.filter((slot) => slot.name !== 'file');
  for (const key of Object.keys(given)) {
    if (key === 'file') {
      throw new HttpError(
        400,
        `${where}: file 由上一步的产物提供（第 1 步为提交的 file / url），不能写在 inputs 里`,
      );
    }
    if (!extraSlots.some((slot) => slot.name === key)) {
      const names = extraSlots.map((slot) => slot.name).join('、');
      throw new HttpError(
        400,
        `${where}: 没有输入 ${key}${names ? `，可用的附加输入: ${names}` : '，该操作没有附加输入'}`,
      );
    }
  }

  const inputs: JobInputs = {};
  const provided: Record<string, number> = { file: 1 };
  for (const slot of extraSlots) {
    const urls = parseUrlList(given[slot.name], `${where}的 inputs.${slot.name}`);
    provided[slot.name] = urls.length;
    const max = slot.multiple?.max ?? 1;
    if (urls.length === 0) {
      if (slot.required) {
        throw new HttpError(
          400,
          `${where}: 缺少输入 ${slot.name}${rangeText(slot)}，请在 inputs.${slot.name} 里提供链接`,
        );
      }
      continue;
    }
    if (urls.length > max) {
      throw new HttpError(
        400,
        `${where}: inputs.${slot.name} 最多 ${max} 个链接，收到 ${urls.length} 个`,
      );
    }
    if (slot.multiple && urls.length < slot.multiple.min) {
      throw new HttpError(
        400,
        `${where}: inputs.${slot.name} 至少需要 ${slot.multiple.min} 个链接，收到 ${urls.length} 个`,
      );
    }
    inputs[slot.name] = urls.map((url) => ({ url }));
  }
  return { inputs, provided };
}

/** 参数里出现了链接字段，多半是照着单个接口的写法把链接写进了 params，给出准确的提示而不是静默丢掉 */
function misplacedUrlField(op: AnyOperation, params: Record<string, unknown>): string | undefined {
  const paramKeys = new Set(Object.keys(op.params.shape));
  if ('callbackUrl' in params) return 'callbackUrl 请写在请求顶层，而不是某一步的 params 里';
  for (const slot of op.inputs) {
    for (const field of urlFieldsOf(slot)) {
      if (!(field in params) || paramKeys.has(field)) continue;
      return slot.name === 'file'
        ? `输入文件来自上一步（第 1 步为提交的 file / url），params 里不能有 ${field}`
        : `链接输入请写在 inputs.${slot.name}，而不是 params.${field}`;
    }
  }
  return undefined;
}

/**
 * 解析并校验 POST /api/pipeline 的请求：顶层的 file / url / fileUrl、callbackUrl 和 steps，
 * 每一步的操作、附加输入和参数（与单个接口相同的 schema 和 check）。不合格时抛 HttpError(400)，信息里带步骤序号
 */
export function preparePipeline(
  req: Request,
  getOperation: (name: string) => AnyOperation | undefined,
): PreparedPipeline {
  const raw: unknown = req.body;
  if (Array.isArray(raw)) throw new HttpError(400, '请求体必须是 JSON 对象');
  const body: Record<string, unknown> = { ...((raw as Record<string, unknown>) ?? {}) };

  const uploads = uploadedFilesBySlot(req);
  const top = resolveRequestInputs([PIPELINE_FILE_SLOT], new Set(), uploads, body);
  const callbackUrl = takeCallbackUrl(body);
  const rawSteps = parseSteps(body.steps);
  delete body.steps;
  const extra = Object.keys(body);
  if (extra.length) {
    throw new HttpError(
      400,
      `不支持的字段: ${extra.slice(0, 5).join(', ')}。每一步的参数请写在 steps[].params 里`,
    );
  }

  const steps: PipelineStepPayload[] = [];
  const ops: AnyOperation[] = [];
  const urls = [...top.urls];
  rawSteps.forEach((rawStep, index) => {
    const n = index + 1;
    if (!isPlainObject(rawStep)) {
      throw new HttpError(400, `第 ${n} 步必须是对象，如 {"op":"trim","params":{…}}`);
    }
    const name = rawStep.op;
    if (typeof name !== 'string' || !name.trim()) {
      throw new HttpError(400, `第 ${n} 步缺少 op（操作名，见 GET /api/operations）`);
    }
    const op = getOperation(name.trim());
    if (!op) {
      throw new HttpError(
        400,
        `第 ${n} 步的操作 ${name.slice(0, 64)} 不存在，可用操作见 GET /api/operations`,
      );
    }
    const where = `第 ${n} 步（${op.name}）`;
    const problem = stepProblem(op, index, rawSteps.length);
    if (problem) throw new HttpError(400, `${where}${problem}`);

    const unknownKeys = Object.keys(rawStep).filter((k) => !['op', 'params', 'inputs'].includes(k));
    if (unknownKeys.length) {
      throw new HttpError(
        400,
        `${where}: 不支持的字段 ${unknownKeys.join(', ')}（只有 op、params、inputs）`,
      );
    }
    const rawParams = rawStep.params ?? {};
    if (!isPlainObject(rawParams)) throw new HttpError(400, `${where}: params 必须是对象`);
    const misplaced = misplacedUrlField(op, rawParams);
    if (misplaced) throw new HttpError(400, `${where}: ${misplaced}`);

    const { inputs, provided } = parseStepInputs(op, rawStep.inputs, where);
    const parsed = op.params.safeParse(normalizeRawParams(rawParams));
    if (!parsed.success) {
      throw new HttpError(400, `${where}: ${formatIssues(parsed.error.issues)}`);
    }
    const params = parsed.data as Record<string, unknown>;
    const failed = op.check?.(params, provided);
    if (failed) throw new HttpError(400, `${where}: ${failed}`);

    for (const items of Object.values(inputs)) {
      for (const item of items) if ('url' in item) urls.push(item.url);
    }
    steps.push({ op: op.name, params, inputs });
    ops.push(op);
  });

  // 上传时按 any 收的文件，现在按第一步的 file 槽复查（链接输入的类型交给 ffprobe 判断，和单个接口一致）
  const firstSlot = fileSlotOf(ops[0]) as InputSlot;
  for (const file of uploads.file ?? []) {
    if (!isAllowedForKind(firstSlot.kind, file.mimetype, file.originalname)) {
      throw new HttpError(
        400,
        `不支持的文件类型: ${file.mimetype}（${file.originalname}），第 1 步（${ops[0].name}）的 file 只接受${KIND_LABELS[firstSlot.kind]}文件`,
      );
    }
  }

  return {
    inputs: top.inputs,
    steps,
    ops,
    urls,
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

/** 新建 pipeline 任务时的步骤状态 */
export function initialSteps(steps: readonly PipelineStepPayload[]): PipelineStep[] {
  return steps.map((step) => ({ op: step.op, status: 'pending' }));
}
