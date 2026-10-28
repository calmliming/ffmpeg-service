import type { AnyOperation } from '../types';
import { info } from './info';
import { transcode } from './transcode';
import { trim } from './trim';
import { extractAudio } from './extract-audio';
import { gif } from './gif';

export const operations: AnyOperation[] = [info, transcode, trim, extractAudio, gif];
