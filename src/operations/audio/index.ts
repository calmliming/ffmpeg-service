import type { AnyOperation } from '../types';
import { concatAudioOperation } from './concat';
import { convertOperation } from './convert';
import { denoiseOperation } from './denoise';
import { fadeOperation } from './fade';
import { mixAudioOperation } from './mix';
import { normalizeOperation } from './normalize';
import { normalizeVideoAudioOperation } from './normalize-video';
import { reverseOperation } from './reverse';
import { spectrogramOperation } from './spectrogram';
import { speedOperation } from './speed';
import { trimAudioOperation } from './trim';
import { trimSilenceOperation } from './trim-silence';
import { volumeOperation } from './volume';
import { waveformOperation } from './waveform';

export const operations: AnyOperation[] = [
  convertOperation,
  normalizeOperation,
  normalizeVideoAudioOperation,
  denoiseOperation,
  trimSilenceOperation,
  volumeOperation,
  fadeOperation,
  speedOperation,
  trimAudioOperation,
  reverseOperation,
  concatAudioOperation,
  mixAudioOperation,
  waveformOperation,
  spectrogramOperation,
];
