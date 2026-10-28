import { KIND_LABELS } from '../middleware/upload';
import type { InputInfo, JsonSchema, OperationInfo } from './catalog';
import { MAX_PIPELINE_STEPS, PIPELINE_ROUTE } from './pipeline';

type Json = Record<string, unknown>;

export interface OpenApiOptions {
  version: string;
  /** servers[0].url：配置了 PUBLIC_BASE_URL 时是它，否则 /（与文档同源） */
  serverUrl: string;
  /** 配置了 API_KEYS：文档里声明安全方案，除健康检查外都要求 Key */
  authEnabled: boolean;
  /** PROTECT_FILES=true：下载也要求 Key */
  protectFiles: boolean;
  maxUploadMb: number;
}

const schemaRef = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string): Json => ({ $ref: `#/components/responses/${name}` });
const json = (schema: Json): Json => ({ 'application/json': { schema } });

const TAG_DESCRIPTIONS: Record<string, string> = {
  general: '常用接口：转码、媒体信息、多段合成',
  edit: '剪辑：截取、合并、提取音频',
  process: '处理：GIF、截图、缩略图、水印',
  video: '视频处理',
  audio: '音频处理',
  analyze: '分析：响度、场景、静音、黑场、波形峰值',
  image: '图片处理',
  pipeline: '多步骤处理：一个文件依次经过多个操作',
  tasks: '任务查询、实时进度与取消',
  files: '产物下载',
  system: '健康检查与接口目录',
};

/** 按路由分组：/api/video/crop → video，/api/transcode 这类一级路由 → general */
function tagOf(route: string): string {
  const parts = route.split('/').filter(Boolean);
  return parts.length >= 3 ? parts[1] : 'general';
}

/** 把 zod 生成的 $defs 挪到 components.schemas（加操作名前缀），并改写引用，嵌在 OpenAPI 里引用才解析得到 */
function hoistDefs(schema: JsonSchema, prefix: string, schemas: Json): JsonSchema {
  const defs = schema.$defs as Record<string, unknown> | undefined;
  const rest: JsonSchema = { ...schema };
  delete rest.$schema;
  delete rest.$defs;
  if (!defs) return rest;
  const keyOf = (name: string) => `${prefix}.${name}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const out: Json = {};
    for (const [key, inner] of Object.entries(value as Json)) {
      out[key] =
        key === '$ref' && typeof inner === 'string' && inner.startsWith('#/$defs/')
          ? `#/components/schemas/${keyOf(inner.slice('#/$defs/'.length))}`
          : rewrite(inner);
    }
    return out;
  };
  for (const [name, def] of Object.entries(defs)) schemas[keyOf(name)] = rewrite(def);
  return rewrite(rest) as JsonSchema;
}

const FILE_SCHEMA: Json = {
  type: 'string',
  format: 'binary',
  contentMediaType: 'application/octet-stream',
};

function fileProperty(slot: InputInfo): Json {
  const description = `${slot.description}（${KIND_LABELS[slot.kind]}）`;
  if (!slot.multiple) return { ...FILE_SCHEMA, description };
  return {
    type: 'array',
    items: FILE_SCHEMA,
    minItems: slot.multiple.min,
    maxItems: slot.multiple.max,
    description: `${description}，同名字段重复 ${slot.multiple.min}-${slot.multiple.max} 次`,
  };
}

function urlProperty(slot: InputInfo): Json {
  const description = `以链接提供 ${slot.name}（与上传 ${slot.name} 二选一，必须是公网 http / https 地址）`;
  if (!slot.multiple) return { type: 'string', format: 'uri', description };
  return {
    type: 'array',
    items: { type: 'string', format: 'uri' },
    minItems: slot.multiple.min,
    maxItems: slot.multiple.max,
    description: `${description}；JSON 里传数组，表单里同名字段重复`,
  };
}

const CALLBACK_PROPERTY: Json = {
  type: 'string',
  format: 'uri',
  description:
    '任务进入终态（completed / failed / cancelled）时 POST { event, task } 到这个地址；配置了 WEBHOOK_SECRET 时带 HMAC 签名头',
};

/** 必填输入槽：上传字段或任一链接字段出现一个即可，用 anyOf + required 表达 */
function inputConstraints(inputs: readonly InputInfo[], withUploads: boolean): Json {
  const groups = inputs
    .filter((slot) => slot.required)
    .map((slot) => [...(withUploads ? [slot.name] : []), ...slot.urlFields]);
  if (groups.length === 0) return {};
  const anyOf = (fields: string[]) => ({ anyOf: fields.map((field) => ({ required: [field] })) });
  if (groups.length === 1) return groups[0].length === 1 ? {} : anyOf(groups[0]);
  return { allOf: groups.map(anyOf) };
}

function requestSchema(op: OperationInfo, params: JsonSchema, multipart: boolean): Json {
  const properties: Json = {};
  for (const slot of op.inputs) {
    if (multipart) properties[slot.name] = fileProperty(slot);
    for (const field of slot.urlFields) {
      // compose 的 videos 这类历史字段：同一个名字既是上传字段也是链接字段，表单里两种都收
      if (multipart && field === slot.name) {
        const file = properties[field] as Json;
        properties[field] = { ...file, description: `${String(file.description)}；也可以填链接` };
        continue;
      }
      properties[field] = urlProperty(slot);
    }
  }
  Object.assign(properties, (params.properties as Json | undefined) ?? {});
  properties.callbackUrl = CALLBACK_PROPERTY;
  const required = [...((params.required as string[] | undefined) ?? [])];
  // 只有一个字段能提供的必填槽（例如没有链接字段）直接列进 required
  for (const slot of op.inputs) {
    const fields = [...(multipart ? [slot.name] : []), ...slot.urlFields];
    if (slot.required && fields.length === 1) required.push(fields[0]);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    ...inputConstraints(op.inputs, multipart),
  };
}

function operationDescription(op: OperationInfo, maxUploadMb: number): string {
  const lines = [op.description, ''];
  lines.push(
    op.sync
      ? '同步接口：在请求里执行，直接返回结果 data，受 SYNC_TIMEOUT_SECONDS 限制。'
      : '异步接口：立即返回 taskId，用 GET /api/tasks/{id} 或 SSE /api/tasks/{id}/progress 查询进度和产物。',
  );
  const inputs = op.inputs.map((slot) => {
    const count = slot.multiple ? `，${slot.multiple.min}-${slot.multiple.max} 个` : '';
    const need = slot.required ? '必填' : '可选';
    return `- \`${slot.name}\`（${KIND_LABELS[slot.kind]}，${need}${count}）：${slot.description}。链接字段：${slot.urlFields.map((f) => `\`${f}\``).join(' / ')}`;
  });
  if (inputs.length)
    lines.push('', '**输入文件**（上传 multipart 字段，或用链接字段提交）：', ...inputs);
  lines.push('', `单个上传文件最大 ${maxUploadMb} MB；表单里的数字和布尔值可以是字符串。`);
  if (op.notes?.length) lines.push('', '**说明**', ...op.notes.map((note) => `- ${note}`));
  if (op.example) lines.push('', '**示例**', '', '```bash', op.example, '```');
  return lines.join('\n');
}

function errorResponses(opts: OpenApiOptions, kind: 'async' | 'sync' | 'read'): Json {
  const out: Json = {};
  if (kind !== 'read') {
    out['400'] = responseRef('BadRequest');
  }
  if (opts.authEnabled) out['401'] = responseRef('Unauthorized');
  if (kind !== 'read') {
    out['413'] = responseRef('PayloadTooLarge');
    out['415'] = responseRef('UnsupportedMediaType');
    out['429'] = responseRef('TooManyRequests');
  }
  if (kind === 'sync') {
    out['499'] = responseRef('ClientClosedRequest');
    out['504'] = responseRef('Timeout');
  } else {
    out['503'] = responseRef('ServiceUnavailable');
  }
  out['500'] = responseRef('ServerError');
  return out;
}

function operationPath(op: OperationInfo, schemas: Json, opts: OpenApiOptions): Json {
  const params = op.params ? hoistDefs(op.params, op.name, schemas) : { properties: {} };
  return {
    post: {
      operationId: op.name,
      tags: [tagOf(op.route)],
      summary: op.sync ? `${op.title}（同步）` : op.title,
      description: operationDescription(op, opts.maxUploadMb),
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': { schema: requestSchema(op, params, true) },
          'application/json': { schema: requestSchema(op, params, false) },
        },
      },
      responses: {
        '200': {
          description: op.sync ? '处理结果' : '已创建任务',
          content: json(schemaRef(op.sync ? 'SyncResponse' : 'TaskAcceptedResponse')),
        },
        ...errorResponses(opts, op.sync ? 'sync' : 'async'),
      },
      ...(op.example
        ? { 'x-codeSamples': [{ lang: 'Shell', label: 'curl', source: op.example }] }
        : {}),
      'x-sync': op.sync,
      'x-chainable': op.chainable,
      'x-pipeline': op.pipeline,
    },
  };
}

const ERROR_RESPONSES: [string, string][] = [
  [
    'BadRequest',
    '参数不合法、缺少或多余的输入、上传与链接混用、文件类型不符、链接不可用、请求体格式错误',
  ],
  ['Unauthorized', '缺少或无效的 API Key'],
  ['NotFound', '任务、操作或接口不存在'],
  ['PayloadTooLarge', '文件超过 MAX_UPLOAD_MB、JSON 请求体超过 100 KB 或表单参数过多'],
  ['UnsupportedMediaType', 'Content-Encoding 不是 identity / gzip / deflate'],
  ['TooManyRequests', '任务队列已满（MAX_QUEUE_LENGTH），或同时执行的同步请求过多'],
  ['ClientClosedRequest', '客户端中断了上传或断开了连接'],
  ['ServiceUnavailable', 'Redis 不可用，任务服务暂时无法使用'],
  ['Timeout', '同步接口超过 SYNC_TIMEOUT_SECONDS'],
  ['ServerError', '其他服务器错误，error 里是原因'],
];

function components(opts: OpenApiOptions): Json {
  const isoDate = { type: 'string', format: 'date-time' };
  const statuses = ['pending', 'processing', 'completed', 'failed', 'cancelled'];
  const schemas: Json = {
    ErrorResponse: {
      type: 'object',
      required: ['success', 'error'],
      properties: {
        success: { const: false },
        error: { type: 'string', description: '中文错误信息' },
      },
    },
    TaskAcceptedResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: {
          type: 'object',
          required: ['taskId', 'status'],
          properties: {
            taskId: { type: 'string', format: 'uuid' },
            status: { const: 'pending' },
          },
        },
      },
    },
    SyncResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { const: true },
        data: { description: '操作返回的结构化结果，结构见各接口说明' },
      },
    },
    TaskOutput: {
      type: 'object',
      required: ['name', 'url', 'size', 'contentType', 'storage'],
      properties: {
        name: {
          type: 'string',
          description: '产物在输出目录里的相对路径，多文件产物带子目录，如 3f2a…/index.m3u8',
        },
        url: { type: 'string', description: '下载地址（本地 /api/files/…，或 S3 地址）' },
        size: { type: 'integer', description: '字节数' },
        contentType: { type: 'string' },
        storage: { enum: ['local', 's3'] },
        key: { type: 'string', description: 'S3 对象 key' },
      },
    },
    TaskCallback: {
      type: 'object',
      required: ['delivered', 'attempts'],
      properties: {
        delivered: { type: 'boolean' },
        attempts: { type: 'integer' },
        status: { type: 'integer', description: '最后一次收到的 HTTP 状态码' },
        error: { type: 'string' },
        deliveredAt: isoDate,
        deliveryId: { type: 'string', description: '与回调请求头 X-FFmpeg-Service-Delivery 相同' },
      },
    },
    PipelineStep: {
      type: 'object',
      required: ['op', 'status'],
      properties: {
        op: { type: 'string' },
        status: { enum: statuses },
      },
    },
    Task: {
      type: 'object',
      required: ['id', 'status', 'progress', 'type', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        type: { type: 'string', description: '操作名；pipeline 任务为 pipeline' },
        status: {
          enum: statuses,
          description: 'completed / failed / cancelled 是终态，之后不再变化',
        },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: '只增不减' },
        phase: {
          enum: [
            'downloading',
            'analyzing',
            'normalizing',
            'merging',
            'processing',
            'encoding',
            'uploading',
          ],
        },
        steps: {
          type: 'array',
          items: schemaRef('PipelineStep'),
          description: '只有 pipeline 任务有：每一步的状态',
        },
        createdAt: isoDate,
        startedAt: isoDate,
        completedAt: isoDate,
        elapsedSeconds: { type: 'integer' },
        outputs: { type: 'array', items: schemaRef('TaskOutput') },
        downloadUrl: { type: 'array', items: { type: 'string' }, description: '= outputs[].url' },
        primaryUrl: { type: 'string', description: '主产物的下载地址' },
        result: { description: '分析类操作的结构化结果' },
        error: { type: 'string', description: '失败或取消的原因' },
        callbackUrl: { type: 'string', format: 'uri' },
        callback: schemaRef('TaskCallback'),
        currentVideoIndex: { type: 'integer', description: '只有 compose' },
        totalVideos: { type: 'integer', description: '只有 compose' },
        output: {
          type: 'string',
          deprecated: true,
          description: '旧字段：产物的服务器绝对路径，逗号分隔。请改用 outputs',
        },
      },
    },
    TaskResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: { success: { const: true }, data: schemaRef('Task') },
    },
    TaskConflictResponse: {
      type: 'object',
      required: ['success', 'error', 'data'],
      properties: {
        success: { const: false },
        error: { type: 'string' },
        data: schemaRef('Task'),
      },
    },
    CancelRequest: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          maxLength: 200,
          description: '取消原因，写进 task.error 和回调；默认「任务已取消」',
        },
      },
    },
    InputInfo: {
      type: 'object',
      required: ['name', 'kind', 'required', 'urlFields', 'description'],
      properties: {
        name: { type: 'string' },
        kind: { enum: Object.keys(KIND_LABELS) },
        required: { type: 'boolean' },
        multiple: {
          type: 'object',
          properties: { min: { type: 'integer' }, max: { type: 'integer' } },
        },
        urlFields: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
      },
    },
    OperationInfo: {
      type: 'object',
      required: ['name', 'method', 'route', 'title', 'description', 'sync', 'chainable', 'inputs'],
      properties: {
        name: { type: 'string' },
        method: { const: 'POST' },
        route: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        sync: { type: 'boolean' },
        chainable: { type: 'boolean' },
        pipeline: {
          type: 'object',
          description: '在 pipeline 里能放的位置',
          properties: {
            first: { type: 'boolean' },
            middle: { type: 'boolean' },
            last: { type: 'boolean' },
          },
        },
        inputs: { type: 'array', items: schemaRef('InputInfo') },
        params: { type: 'object', description: '参数的 JSON Schema（draft 2020-12）' },
        example: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    Health: {
      type: 'object',
      properties: {
        service: { const: 'ffmpeg-service' },
        version: { type: 'string' },
        status: { enum: ['running', 'degraded'] },
        ffmpeg: { enum: ['available', 'not found'] },
        redis: { enum: ['available', 'unavailable'] },
        storage: { enum: ['local', 's3'] },
        operations: { type: 'integer', description: '已注册的操作数' },
        queue: {
          type: ['object', 'null'],
          description: '队列里各状态的任务数；Redis 不可用或超时为 null',
          properties: {
            waiting: { type: 'integer' },
            active: { type: 'integer' },
            delayed: { type: 'integer' },
            failed: { type: 'integer' },
          },
        },
        auth: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, protectFiles: { type: 'boolean' } },
        },
        timestamp: isoDate,
      },
    },
    PipelineStepRequest: {
      type: 'object',
      required: ['op'],
      properties: {
        op: { type: 'string', description: '操作名，见 GET /api/operations' },
        params: { type: 'object', description: '该操作的参数，与单独调用时相同' },
        inputs: {
          type: 'object',
          description:
            'file 以外的附加输入（如 watermark 的 image），{ 槽名: 链接 | 链接数组 }。file 由上一步的主产物提供',
          additionalProperties: {
            oneOf: [
              { type: 'string', format: 'uri' },
              { type: 'array', items: { type: 'string', format: 'uri' } },
            ],
          },
        },
      },
    },
  };
  const stepsSchema = {
    type: 'array',
    minItems: 1,
    maxItems: MAX_PIPELINE_STEPS,
    items: schemaRef('PipelineStepRequest'),
  };
  schemas.PipelineRequest = {
    type: 'object',
    required: ['steps'],
    anyOf: [{ required: ['url'] }, { required: ['fileUrl'] }],
    properties: {
      url: { type: 'string', format: 'uri', description: '第一步的输入文件链接' },
      fileUrl: { type: 'string', format: 'uri', description: '同 url' },
      steps: stepsSchema,
      callbackUrl: CALLBACK_PROPERTY,
    },
  };
  schemas.PipelineMultipartRequest = {
    type: 'object',
    required: ['steps'],
    properties: {
      file: { ...FILE_SCHEMA, description: '第一步的输入文件（或改用 url / fileUrl 字段给链接）' },
      url: { type: 'string', format: 'uri' },
      fileUrl: { type: 'string', format: 'uri' },
      steps: { type: 'string', description: 'steps 数组的 JSON 字符串，结构同 JSON 请求' },
      callbackUrl: CALLBACK_PROPERTY,
    },
  };

  const responses: Json = {};
  for (const [name, description] of ERROR_RESPONSES) {
    responses[name] = { description, content: json(schemaRef('ErrorResponse')) };
  }
  return {
    schemas,
    responses,
    ...(opts.authEnabled
      ? {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description: 'Authorization: Bearer <key>',
            },
            apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            apiKeyQuery: {
              type: 'apiKey',
              in: 'query',
              name: 'api_key',
              description:
                '给不能设置请求头的 EventSource（SSE）用，Key 会出现在访问日志里，能用请求头时优先用请求头',
            },
          },
        }
      : {}),
  };
}

const idParam = (description: string): Json => ({
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

function platformPaths(opts: OpenApiOptions): Json {
  const publicOp = { security: [] };
  const cancel = {
    tags: ['tasks'],
    summary: '取消任务',
    description: [
      '排队中的任务直接从队列删除；执行中的任务通过 Redis 广播通知执行它的实例，中止 ffmpeg、下载和上传并清理现场。',
      '任务立即变成 cancelled（之后的进度和完成都不会覆盖），有 callbackUrl 时投递 task.cancelled。',
      '已经是终态（completed / failed / cancelled）时返回 409 和当前任务。',
    ].join('\n\n'),
    parameters: [idParam('任务 ID')],
    requestBody: { required: false, content: json(schemaRef('CancelRequest')) },
    responses: {
      '200': { description: '已取消，返回任务', content: json(schemaRef('TaskResponse')) },
      '400': responseRef('BadRequest'),
      ...(opts.authEnabled ? { '401': responseRef('Unauthorized') } : {}),
      '404': responseRef('NotFound'),
      '409': { description: '任务已经结束', content: json(schemaRef('TaskConflictResponse')) },
      '503': responseRef('ServiceUnavailable'),
      '500': responseRef('ServerError'),
    },
  };
  const readErrors = errorResponses(opts, 'read');
  return {
    '/api/health': {
      get: {
        tags: ['system'],
        operationId: 'health',
        summary: '健康检查',
        description: '检查 ffmpeg / ffprobe 和 Redis。任一不可用返回 503。不需要 API Key。',
        ...publicOp,
        responses: {
          '200': {
            description: '服务正常',
            content: json({
              type: 'object',
              properties: { success: { const: true }, data: schemaRef('Health') },
            }),
          },
          '503': {
            description: '有依赖不可用，error 里列出',
            content: json({
              type: 'object',
              properties: {
                success: { const: false },
                error: { type: 'string' },
                data: schemaRef('Health'),
              },
            }),
          },
        },
      },
    },
    '/api/operations': {
      get: {
        tags: ['system'],
        operationId: 'listOperations',
        summary: '操作列表',
        description: '所有操作的路由、输入槽、链接字段、参数 JSON Schema、示例和说明。',
        responses: {
          '200': {
            description: '操作列表',
            content: json({
              type: 'object',
              properties: {
                success: { const: true },
                data: { type: 'array', items: schemaRef('OperationInfo') },
              },
            }),
          },
          ...readErrors,
        },
      },
    },
    '/api/operations/{name}': {
      get: {
        tags: ['system'],
        operationId: 'getOperation',
        summary: '单个操作的说明',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: '操作名',
          },
        ],
        responses: {
          '200': {
            description: '操作说明',
            content: json({
              type: 'object',
              properties: { success: { const: true }, data: schemaRef('OperationInfo') },
            }),
          },
          '404': responseRef('NotFound'),
          ...readErrors,
        },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['system'],
        operationId: 'openapi',
        summary: 'OpenAPI 文档',
        description: '本文档，由操作注册表生成。',
        responses: {
          '200': { description: 'OpenAPI 3.1 文档', content: json({ type: 'object' }) },
          ...readErrors,
        },
      },
    },
    [PIPELINE_ROUTE]: {
      post: {
        tags: ['pipeline'],
        operationId: 'pipeline',
        summary: '多步骤处理（pipeline）',
        description: [
          `一个文件依次经过最多 ${MAX_PIPELINE_STEPS} 个操作，作为一个任务（type 为 pipeline）执行，上一步的主产物是下一步的 file。`,
          '每一步的 params 与单独调用该接口时相同，提交时全部校验，出错返回 400 并指出第几步。',
          '每一步都必须有单文件的 file 输入；中间步骤必须是 chainable 的操作（只产出一个主文件）；第一步和最后一步不限，最后一步可以是 HLS、抽帧、分析这类多文件或纯数据的操作。',
          '附加输入（如水印图片）用 inputs 给链接；所有链接在开始处理前一起下载。中间产物放在任务的临时目录里，任务结束即删除；只有最后一步的产物会保存。',
          '进度按步骤平均分配，task.steps 给出每一步的状态；可以随时取消。',
          '',
          '```bash',
          `curl -X POST http://localhost:9527${PIPELINE_ROUTE} -H "Content-Type: application/json" -d '{"url":"https://example.com/in.mp4","steps":[{"op":"trim","params":{"startTime":5,"duration":10}},{"op":"video.resize","params":{"width":720}},{"op":"watermark","params":{"position":"bottom-right"},"inputs":{"image":"https://example.com/logo.png"}}]}'`,
          '',
          `curl -X POST http://localhost:9527${PIPELINE_ROUTE} -F "file=@in.mp4" -F 'steps=[{"op":"trim","params":{"startTime":0,"duration":30}},{"op":"video.hls"}]'`,
          '```',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: schemaRef('PipelineRequest') },
            'multipart/form-data': { schema: schemaRef('PipelineMultipartRequest') },
          },
        },
        responses: {
          '200': { description: '已创建任务', content: json(schemaRef('TaskAcceptedResponse')) },
          ...errorResponses(opts, 'async'),
        },
      },
    },
    '/api/tasks/{id}': {
      get: {
        tags: ['tasks'],
        operationId: 'getTask',
        summary: '查询任务',
        parameters: [idParam('任务 ID')],
        responses: {
          '200': { description: '任务详情', content: json(schemaRef('TaskResponse')) },
          '404': responseRef('NotFound'),
          ...readErrors,
        },
      },
      delete: { ...cancel, operationId: 'deleteTask' },
    },
    '/api/tasks/{id}/cancel': {
      post: { ...cancel, operationId: 'cancelTask' },
    },
    '/api/tasks/{id}/progress': {
      get: {
        tags: ['tasks'],
        operationId: 'taskProgress',
        summary: '实时进度（SSE）',
        description:
          '先推送当前状态，之后每次变化推送一条 `data: <Task JSON>`，进入终态后关闭连接；每 15 秒一次心跳。EventSource 不能带请求头，需要鉴权时用 ?api_key=。',
        parameters: [idParam('任务 ID')],
        responses: {
          '200': {
            description: '事件流，每条 data 是一个 Task 对象（JSON）',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          '404': responseRef('NotFound'),
          ...readErrors,
        },
      },
    },
    '/api/files/{name}': {
      get: {
        tags: ['files'],
        operationId: 'downloadFile',
        summary: '下载产物',
        description:
          '本地存储的产物。name 是 outputs[].name，多文件产物带子目录（如 3f2a…/index.m3u8）。SAVE_OUTPUT_FILE=false 时输出目录顶层的文件被完整下载一次后删除。' +
          (opts.protectFiles ? '需要 API Key（PROTECT_FILES=true）。' : '不需要 API Key。'),
        ...(opts.protectFiles ? {} : publicOp),
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: '产物相对路径，可以带一级子目录',
          },
        ],
        responses: {
          '200': {
            description: '文件内容',
            content: { 'application/octet-stream': { schema: FILE_SCHEMA } },
          },
          ...(opts.protectFiles && opts.authEnabled ? { '401': responseRef('Unauthorized') } : {}),
          '404': { description: '文件不存在' },
        },
      },
    },
  };
}

/** 由操作目录生成 OpenAPI 3.1 文档 */
export function buildOpenApiDocument(
  catalog: readonly OperationInfo[],
  opts: OpenApiOptions,
): Json {
  const comps = components(opts);
  const schemas = comps.schemas as Json;
  const paths: Json = platformPaths(opts);
  for (const op of catalog) paths[op.route] = operationPath(op, schemas, opts);

  const tags = new Set<string>(['system', 'tasks', 'pipeline', 'files']);
  for (const op of catalog) tags.add(tagOf(op.route));
  return {
    openapi: '3.1.0',
    info: {
      title: 'FFmpeg Service API',
      version: opts.version,
      description: [
        '通用的 FFmpeg HTTP 服务。每个操作是一个 POST 接口：输入文件用 multipart 上传，或用链接字段（JSON 或表单）提交。',
        '异步接口立即返回 taskId，通过 GET /api/tasks/{id}、SSE 进度或 callbackUrl 回调拿结果；可以随时取消。',
        `多个操作可以用 POST ${PIPELINE_ROUTE} 串成一个任务。`,
        '错误响应统一为 { "success": false, "error": "<中文信息>" }。',
      ].join('\n\n'),
    },
    servers: [{ url: opts.serverUrl }],
    tags: [...tags].map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    ...(opts.authEnabled
      ? { security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, { apiKeyQuery: [] }] }
      : {}),
    paths,
    components: comps,
  };
}
