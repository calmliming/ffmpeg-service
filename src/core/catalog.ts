import { z } from 'zod';
import type { AnyOperation, InputKind } from '../operations/types';
import { urlFieldsOf } from './inputs';
import { pipelineRoles, type PipelineRoles } from './pipeline';

export type JsonSchema = Record<string, unknown>;

/**
 * 操作参数的 JSON Schema。按输出（io: 'output'）生成，类型是 coerce 工具转换后的类型，default 也会列出来；
 * 但输出模式把有默认值的字段都算作 required、并加上 additionalProperties: false，这两点对请求方都是误导：
 * required 换成按输入（io: 'input'）算出的真正必填字段，未知字段会被忽略而不是报错，所以去掉 additionalProperties
 */
export function paramsJsonSchema(op: AnyOperation): JsonSchema | undefined {
  try {
    const output = z.toJSONSchema(op.params, {
      io: 'output',
      unrepresentable: 'any',
    }) as JsonSchema;
    const input = z.toJSONSchema(op.params, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    const schema: JsonSchema = { ...output };
    delete schema.additionalProperties;
    const required = Array.isArray(input.required) ? (input.required as string[]) : [];
    if (required.length) schema.required = required;
    else delete schema.required;
    return schema;
  } catch {
    return undefined;
  }
}

export interface InputInfo {
  name: string;
  kind: InputKind;
  required: boolean;
  multiple?: { min: number; max: number };
  /** 以链接提交时可用的字段名（已按默认规则展开） */
  urlFields: string[];
  description: string;
}

export interface OperationInfo {
  name: string;
  method: 'POST';
  route: string;
  title: string;
  description: string;
  sync: boolean;
  chainable: boolean;
  /** 在 POST /api/pipeline 里能放在哪些位置 */
  pipeline: PipelineRoles;
  inputs: InputInfo[];
  params?: JsonSchema;
  example?: string;
  notes?: string[];
}

/** GET /api/operations 返回的操作说明，OpenAPI 文档也由它生成 */
export function describeOperation(op: AnyOperation): OperationInfo {
  const params = paramsJsonSchema(op);
  return {
    name: op.name,
    method: 'POST',
    route: op.route,
    title: op.title,
    description: op.description,
    sync: Boolean(op.sync),
    chainable: Boolean(op.chainable),
    pipeline: pipelineRoles(op),
    inputs: op.inputs.map((slot) => ({
      name: slot.name,
      kind: slot.kind,
      required: slot.required,
      ...(slot.multiple ? { multiple: slot.multiple } : {}),
      urlFields: urlFieldsOf(slot),
      description: slot.description,
    })),
    ...(params ? { params } : {}),
    ...(op.example ? { example: op.example } : {}),
    ...(op.notes?.length ? { notes: op.notes } : {}),
  };
}
