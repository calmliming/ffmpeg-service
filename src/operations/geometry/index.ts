import type { AnyOperation } from '../types';
import { crop } from './crop';
import { resize } from './resize';
import { reframe } from './reframe';
import { rotate } from './rotate';
import { pip } from './pip';
import { stack } from './stack';

export const operations: AnyOperation[] = [crop, resize, reframe, rotate, pip, stack];
