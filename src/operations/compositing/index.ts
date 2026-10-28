import type { AnyOperation } from '../types';
import { subtitles } from './subtitles';
import { mixAudio } from './mix-audio';
import { fromAudio } from './from-audio';
import { slideshow } from './slideshow';

export const operations: AnyOperation[] = [subtitles, mixAudio, fromAudio, slideshow];
