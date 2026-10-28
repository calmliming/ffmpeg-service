import type { AnyOperation } from './types';
import { operations as basic } from './basic';
import { operations as visual } from './visual';
import { operations as geometry } from './geometry';
import { operations as timeline } from './timeline';
import { operations as effects } from './effects';
import { operations as compositing } from './compositing';
import { operations as audio } from './audio';
import { operations as analysis } from './analysis';

export const operations: readonly AnyOperation[] = [
  ...basic,
  ...visual,
  ...geometry,
  ...timeline,
  ...effects,
  ...compositing,
  ...audio,
  ...analysis,
];

// 名称或路由重复时两个操作会互相覆盖，启动时直接失败
const byName = new Map<string, AnyOperation>();
const routes = new Set<string>();
for (const op of operations) {
  if (byName.has(op.name)) throw new Error(`操作名称重复: ${op.name}`);
  if (routes.has(op.route)) throw new Error(`操作路由重复: ${op.route}`);
  byName.set(op.name, op);
  routes.add(op.route);
}

export function getOperation(name: string): AnyOperation | undefined {
  return byName.get(name);
}
