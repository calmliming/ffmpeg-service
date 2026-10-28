import type { AnyOperation } from '../types';
import { blur } from './blur';
import { delogo } from './delogo';
import { color } from './color';
import { enhance } from './enhance';
import { stabilize } from './stabilize';
import { mute } from './mute';
import { compress } from './compress';

export const operations: AnyOperation[] = [blur, delogo, color, enhance, stabilize, mute, compress];
