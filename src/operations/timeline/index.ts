import type { AnyOperation } from '../types';
import { cutOperation } from './cut';
import { fadeOperation } from './fade';
import { loopOperation } from './loop';
import { mergeOperation } from './merge';
import { reverseOperation } from './reverse';
import { speedOperation } from './speed';
import { splitOperation } from './split';

export const operations: AnyOperation[] = [
  mergeOperation,
  speedOperation,
  reverseOperation,
  loopOperation,
  fadeOperation,
  cutOperation,
  splitOperation,
];
