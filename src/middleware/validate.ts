import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/** zod 会为数组里每个不合格元素各记一条错误，全部拼进响应时一个 100 KB 的请求能换回几 MB，只返回前几条 */
const MAX_MESSAGES = 10;

/**
 * 把 zod 的错误拼成一条中文提示。自定义信息一般已经带了字段名；
 * 没带的（zod 默认信息、数组元素的错误）在前面补上字段路径，客户端才知道是哪个参数
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  // 同一参数的几个部分（size 的宽和高）可能各报一条一模一样的信息，只留一条
  const messages = [
    ...new Set(
      issues.map((issue) => {
        const key = issue.path.map(String).join('.');
        const top = issue.path.length ? String(issue.path[0]) : '';
        return top && !issue.message.includes(top) ? `${key}: ${issue.message}` : issue.message;
      }),
    ),
  ];
  const rest = messages.length - MAX_MESSAGES;
  const suffix = rest > 0 ? `，另有 ${rest} 条错误未列出` : '';
  return messages.slice(0, MAX_MESSAGES).join(', ') + suffix;
}

export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Express 5 没有请求体时 req.body 是 undefined 而不是 {}，不兜底的话会丢掉字段级的中文提示
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      res.status(400).json({ success: false, error: formatIssues(result.error.issues) });
      return;
    }
    req.body = result.data;
    next();
  };
}
