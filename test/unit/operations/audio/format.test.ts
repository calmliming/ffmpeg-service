import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  audioStreamDuration,
  decodedDuration,
  encodeArgs,
  fitSampleRate,
  formatFromProbe,
  kbpsParam,
  num,
  sampleRateProblem,
  vorbisQuality,
} from '../../../../src/operations/audio/format';

const kbps = z.object({ bitrate: kbpsParam('bitrate').optional() });
const parseKbps = (value: unknown) => kbps.safeParse({ bitrate: value });

test('kbpsParam 接受 k / M 单位、bps 数字和不超过 1000 的 kbps 数字', () => {
  assert.equal(parseKbps('128k').data?.bitrate, 128);
  assert.equal(parseKbps('0.32M').data?.bitrate, 320);
  assert.equal(parseKbps('192000').data?.bitrate, 192);
  assert.equal(parseKbps(256).data?.bitrate, 256);
  assert.equal(parseKbps('96').data?.bitrate, 96);
});

test('kbpsParam 拒绝格式错误和超出范围的码率', () => {
  for (const bad of ['abc', '1G', '4k', '600k', -5]) {
    const result = parseKbps(bad);
    assert.equal(result.success, false, String(bad));
    assert.match(result.error!.issues[0].message, /bitrate 必须是 8k 到 512k 之间的码率/);
  }
});

test('formatFromProbe 按容器和编码识别输入格式', () => {
  const probe = (formatName: string, codec: string, video = false, cover = false) => ({
    format: { format_name: formatName },
    streams: [
      { codec_type: 'audio', codec_name: codec },
      ...(video
        ? [
            {
              codec_type: 'video',
              codec_name: 'h264',
              disposition: { attached_pic: cover ? 1 : 0 },
            },
          ]
        : []),
    ],
  });
  assert.equal(formatFromProbe(probe('mp3', 'mp3', true, true)), 'mp3');
  assert.equal(formatFromProbe(probe('wav', 'pcm_s24le')), 'wav');
  assert.equal(formatFromProbe(probe('flac', 'flac')), 'flac');
  assert.equal(formatFromProbe(probe('aac', 'aac')), 'aac');
  assert.equal(formatFromProbe(probe('ogg', 'vorbis')), 'ogg');
  assert.equal(formatFromProbe(probe('ogg', 'opus')), 'opus');
  assert.equal(formatFromProbe(probe('mov,mp4,m4a,3gp,3g2,mj2', 'aac')), 'm4a');
  assert.equal(formatFromProbe(probe('mov,mp4,m4a,3gp,3g2,mj2', 'aac', true, true)), 'm4a');
  // 带画面的 mp4 不算 m4a，交给调用方退回 mp3
  assert.equal(formatFromProbe(probe('mov,mp4,m4a,3gp,3g2,mj2', 'aac', true)), undefined);
  assert.equal(formatFromProbe(probe('matroska,webm', 'opus')), undefined);
  assert.equal(formatFromProbe({}), undefined);
});

test('audioStreamDuration 取第一条音轨自身的时长，拿不到时返回 0', () => {
  const raw = (streams: unknown[]) => ({ format: { duration: '3.000' }, streams });
  assert.equal(
    audioStreamDuration(
      raw([
        { codec_type: 'video', duration: '3.000' },
        { codec_type: 'audio', duration: '2.005' },
        { codec_type: 'audio', duration: '1.000' },
      ]),
    ),
    2.005,
  );
  // mkv / webm 的流上没有 duration
  assert.equal(audioStreamDuration(raw([{ codec_type: 'audio' }])), 0);
  assert.equal(audioStreamDuration(raw([{ codec_type: 'audio', duration: 'N/A' }])), 0);
  assert.equal(audioStreamDuration({}), 0);
});

test('sampleRateProblem / fitSampleRate 处理编码器不支持的采样率', () => {
  assert.equal(sampleRateProblem('mp3', 44100), undefined);
  assert.equal(sampleRateProblem('flac', 96000), undefined);
  assert.match(sampleRateProblem('mp3', 96000) ?? '', /mp3 格式不支持 96000 Hz 采样率/);
  assert.match(sampleRateProblem('opus', 44100) ?? '', /可选 8000 \/ 16000 \/ 24000 \/ 48000/);
  assert.equal(fitSampleRate('opus', 44100), 48000);
  assert.equal(fitSampleRate('mp3', 96000), 48000);
  assert.equal(fitSampleRate('wav', 96000), 96000);
  assert.equal(fitSampleRate('m4a', 0), 48000);
});

test('encodeArgs 生成各格式的编码参数并夹住码率上限', () => {
  assert.deepEqual(encodeArgs({ format: 'mp3' }), [
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-f',
    'mp3',
  ]);
  assert.deepEqual(encodeArgs({ format: 'mp3', bitrate: 500 }).slice(2, 4), ['-b:a', '320k']);
  assert.deepEqual(encodeArgs({ format: 'wav', bitrate: 320, sampleRate: 22050, channels: 1 }), [
    '-c:a',
    'pcm_s16le',
    '-ar',
    '22050',
    '-ac',
    '1',
    '-f',
    'wav',
  ]);
  assert.deepEqual(encodeArgs({ format: 'ogg', bitrate: 128 }).slice(2, 4), ['-q:a', '4']);
  assert.deepEqual(encodeArgs({ format: 'opus', bitrate: 512, inputChannels: 1 }).slice(2, 4), [
    '-b:a',
    '256k',
  ]);
  assert.deepEqual(encodeArgs({ format: 'opus', bitrate: 512, channels: 2 }).slice(2, 4), [
    '-b:a',
    '510k',
  ]);
  assert.ok(encodeArgs({ format: 'm4a' }).join(' ').includes('-movflags +faststart -f ipod'));
  assert.equal(vorbisQuality(30), -1);
  assert.equal(vorbisQuality(1000), 10);
});

test('num 输出不带科学计数法的短小数，decodedDuration 取最后一个 time=', () => {
  assert.equal(num(1.5), '1.5');
  assert.equal(num(10), '10');
  assert.equal(num(0), '0');
  assert.equal(num(1e-7), '0');
  assert.equal(num(-14.257, 2), '-14.26');
  assert.equal(num(1 / 3), '0.333333');
  assert.equal(
    decodedDuration('size=N/A time=00:00:01.00 x\nsize=N/A time=01:02:03.50 bitrate=N/A'),
    3723.5,
  );
  assert.equal(decodedDuration('nothing here'), undefined);
});
