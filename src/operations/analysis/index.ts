import type { AnyOperation } from '../types';
import { black } from './black';
import { dash } from './dash';
import { hls } from './hls';
import { imageConvert } from './image-convert';
import { loudness } from './loudness';
import { peaks } from './peaks';
import { scenes } from './scenes';
import { silence } from './silence';

export const operations: AnyOperation[] = [
  loudness,
  scenes,
  silence,
  black,
  peaks,
  hls,
  dash,
  imageConvert,
];
