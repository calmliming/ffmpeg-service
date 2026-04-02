import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '../types';

export function errorHandler(err: Error, _req: Request, res: Response<ApiResponse>, _next: NextFunction) {
  console.error(`[Error] ${err.message}`);
  res.status(500).json({
    success: false,
    error: err.message,
  });
}
