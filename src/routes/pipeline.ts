import { Router, type NextFunction, type Request, type Response } from 'express';
import { assertPublicUrls } from '../core/inputs';
import {
  initialSteps,
  PIPELINE_FILE_SLOT,
  PIPELINE_OP,
  PIPELINE_ROUTE,
  preparePipeline,
} from '../core/pipeline';
import { createUploadMiddleware } from '../middleware/upload';
import type { AnyOperation } from '../operations/types';
import { enqueueTask, fail, type OperationRouteDeps } from './operations';

/**
 * POST /api/pipeline：一个文件依次经过多个操作，作为一个任务执行。
 * JSON：{ url | fileUrl, steps: [{ op, params?, inputs? }], callbackUrl? }；
 * multipart：file 上传，steps 字段是同样结构的 JSON 字符串
 */
export function createPipelineRouter(
  operations: readonly AnyOperation[],
  deps: OperationRouteDeps,
): Router {
  const router = Router();
  const byName = new Map(operations.map((op) => [op.name, op]));
  router.post(
    PIPELINE_ROUTE,
    createUploadMiddleware([PIPELINE_FILE_SLOT]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const prepared = preparePipeline(req, (name) => byName.get(name));
        const { inputs, steps, callbackUrl } = prepared;
        await assertPublicUrls([...prepared.urls, ...(callbackUrl ? [callbackUrl] : [])]);
        await enqueueTask(req, res, deps, {
          name: PIPELINE_OP,
          callbackUrl,
          steps: initialSteps(steps),
          payload: (taskId) => ({
            taskId,
            op: PIPELINE_OP,
            inputs,
            steps,
            ...(callbackUrl ? { callbackUrl } : {}),
          }),
        });
      } catch (err) {
        fail(res, next, err);
      }
    },
  );
  return router;
}
