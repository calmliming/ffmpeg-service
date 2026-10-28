import { z } from 'zod';

// PHP 表单、Go 的 map[string]string、multipart 字段都把数字和布尔值发成字符串，这里先做宽松转换再校验

export const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const toNumber = (value: unknown) => {
  const v = blankToUndefined(value);
  return typeof v === 'string' ? Number(v) : v;
};

export const toBoolean = (value: unknown) => {
  const v = blankToUndefined(value);
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  if (v === 1) return true;
  if (v === 0) return false;
  return v;
};

export const toArray = (value: unknown) => (typeof value === 'string' ? [value] : value);

/** 单个字符串按逗号拆成数组（如 timestamps=1,2,3），数组原样返回 */
export const toList = (value: unknown) => {
  const v = blankToUndefined(value);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return v;
};

// 只放行 http(s)，file:// 之类的地址会被当成服务器本地路径读取
export const httpUrl = (message: string) =>
  z
    .string()
    .trim()
    .pipe(z.url({ error: message }))
    .refine((url) => /^https?:\/\//i.test(url), { error: '只支持 http 或 https 链接' });

export function numberParam(
  name: string,
  opts: { min?: number; max?: number; int?: boolean } = {},
) {
  const range =
    opts.min !== undefined && opts.max !== undefined
      ? ` ${opts.min} 到 ${opts.max} 之间的`
      : opts.min !== undefined
        ? `不小于 ${opts.min} 的`
        : '';
  const kind = opts.int ? '整数' : '数字';
  const message = `${name} 必须是${range}${kind}`;
  let schema = z.number({ error: message });
  if (opts.int) schema = schema.int({ error: message });
  if (opts.min !== undefined) schema = schema.min(opts.min, { error: message });
  if (opts.max !== undefined) schema = schema.max(opts.max, { error: message });
  return z.preprocess(toNumber, schema);
}

export function booleanParam(name: string) {
  return z.preprocess(toBoolean, z.boolean({ error: `${name} 必须是布尔值（true / false）` }));
}

export function enumParam<const T extends readonly [string, ...string[]]>(name: string, values: T) {
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      return typeof v === 'string' ? v.trim().toLowerCase() : v;
    },
    z.enum(values, { error: `${name} 只能是 ${values.join(' / ')}` }),
  );
}

/**
 * 时间点或时长：接受秒数（10、10.5）或 [[HH:]MM:]SS[.mmm]（00:00:10、1:02.5），统一转成秒数。
 * 输出总是数字，拼进 FFmpeg 参数时不需要再转义。
 */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(s);
  if (!match) return undefined;
  const [, h, m, sec] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(sec);
}

export function timeParam(name: string) {
  const message = `${name} 必须是秒数或 HH:MM:SS 格式的时间`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (v === undefined) return undefined;
      return parseTime(v) ?? Number.NaN;
    },
    z.number({ error: message }).min(0, { error: message }),
  );
}

// FFmpeg 认识的颜色名（与 CSS 颜色名一致），校验后原样传给滤镜，不会带入特殊字符
const COLOR_NAMES = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred ' +
    'darksalmon darkseagreen darkslateblue darkslategray darkturquoise darkviolet deeppink deepskyblue dimgray ' +
    'dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon ' +
    'lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightgrey lightpink lightsalmon ' +
    'lightseagreen lightskyblue lightslategray lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip ' +
    'peachpuff peru pink plum powderblue purple red rosybrown royalblue saddlebrown salmon sandybrown seagreen ' +
    'seashell sienna silver skyblue slateblue slategray snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/**
 * 颜色：颜色名（white、red）、#RRGGBB、#RRGGBBAA、0xRRGGBB，可带 @透明度（white@0.5）。
 * 输出统一为 FFmpeg 格式（0xRRGGBB[AA][@a] 或小写颜色名）。
 */
export function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match =
    /^\s*([#]|0x)?([0-9a-f]{6}|[0-9a-f]{8}|[a-z]+)(?:@(0(?:\.\d+)?|1(?:\.0+)?))?\s*$/i.exec(value);
  if (!match) return undefined;
  const [, prefix, body, alpha] = match;
  let color: string;
  if (prefix) {
    if (!/^[0-9a-f]+$/i.test(body)) return undefined;
    color = `0x${body.toUpperCase()}`;
  } else if (COLOR_NAMES.has(body.toLowerCase())) {
    color = body.toLowerCase();
  } else if (/^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(body)) {
    color = `0x${body.toUpperCase()}`;
  } else {
    return undefined;
  }
  return alpha === undefined ? color : `${color}@${alpha}`;
}

export function colorParam(name: string) {
  const message = `${name} 必须是颜色名（如 white）、#RRGGBB 或 #RRGGBBAA，可带 @透明度（如 white@0.5）`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (v === undefined) return undefined;
      return parseColor(v) ?? '';
    },
    z.string({ error: message }).min(1, { error: message }),
  );
}

/** 分辨率 WxH（如 1280x720），宽高必须是 2-8192 的整数 */
export function sizeParam(name: string) {
  const message = `${name} 必须是 宽x高 格式，如 1280x720（每边 2-8192）`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (typeof v !== 'string') return v;
      const match = /^\s*(\d{1,4})\s*[xX*:]\s*(\d{1,4})\s*$/.exec(v);
      if (!match) return null;
      return { width: Number(match[1]), height: Number(match[2]) };
    },
    z.object(
      {
        width: z
          .number({ error: message })
          .int()
          .min(2, { error: message })
          .max(8192, { error: message }),
        height: z
          .number({ error: message })
          .int()
          .min(2, { error: message })
          .max(8192, { error: message }),
      },
      { error: message },
    ),
  );
}

/** 码率：数字加可选单位 k / M（如 128k、2.5M、800000） */
export function bitrateParam(name: string) {
  const message = `${name} 必须是码率，如 128k、2M 或 800000`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      return typeof v === 'number' ? String(v) : v;
    },
    z
      .string({ error: message })
      .trim()
      .regex(/^\d{1,9}(\.\d{1,3})?[kKmM]?$/, { error: message }),
  );
}
