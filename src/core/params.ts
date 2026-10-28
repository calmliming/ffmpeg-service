/**
 * 参数校验前的统一预处理：空字符串（含全空白）视为没传。
 * 表单和 Go / PHP 客户端常把没填的字段发成空串，在这里去掉后，schema 里的 .optional() / .default() 才能按「没传」处理。
 * 只处理顶层字段，嵌套对象和数组原样保留
 */
export function normalizeRawParams(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    result[key] = value;
  }
  return result;
}
