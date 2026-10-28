import type { AnyOperation } from '../types';
import { watermark } from './watermark';
import { screenshot } from './screenshot';
import { thumbnail } from './thumbnail';
import { compose } from './compose';
import { sprite } from './sprite';
import { frames } from './frames';
import { cover } from './cover';

export const operations: AnyOperation[] = [
  watermark,
  screenshot,
  thumbnail,
  compose,
  sprite,
  frames,
  cover,
];
