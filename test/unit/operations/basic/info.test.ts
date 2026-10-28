import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../../../src/config';
import { HttpError } from '../../../../src/middleware/error';
import { info, toLegacyProbe } from '../../../../src/operations/basic/info';
import {
  ffmpegSkip,
  generate,
  makeAudio,
  makeImage,
  makeSrt,
  makeTempDir,
  makeVideo,
} from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { expectRunError } from './helpers';

type Section = Record<string, unknown>;
interface Legacy {
  streams: Section[];
  format: Section;
  chapters: Section[];
}

let dir = '';
let video = '';
let rotated = '';
let chaptered = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-basic-info-');
  video = makeVideo(dir, 'in.mp4');
  rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  const meta = path.join(dir, 'chapters.txt');
  fs.writeFileSync(
    meta,
    [
      ';FFMETADATA1',
      'title=Sample 123',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=0',
      'END=1000',
      'title=Intro',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=1000',
      'END=2000',
      'title=Main',
      '',
    ].join('\n'),
  );
  chaptered = path.join(dir, 'chaptered.mp4');
  generate([
    '-i',
    video,
    '-i',
    meta,
    '-map_metadata',
    '1',
    '-map_chapters',
    '1',
    '-c',
    'copy',
    chaptered,
  ]);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

/**
 * fluent-ffmpeg 2.1 lib/ffprobe.js 的解析逻辑（旧版 /api/info 的实现）：
 * 跑 ffprobe 默认文本输出，非 TAG: 的非负数字字符串转数字，TAG: / DISPOSITION: 前缀收进 tags / disposition
 */
function fluentProbe(file: string): Legacy {
  const out = execFileSync(config.ffprobePath, ['-show_streams', '-show_format', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = out.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const data: Legacy = { streams: [], format: {}, chapters: [] };
  const parseBlock = (name: string): Section => {
    const block: Section = {};
    let line = lines.shift();
    while (line !== undefined) {
      if (line.toLowerCase() === `[/${name}]`) return block;
      if (!line.startsWith('[')) {
        const kv = /^([^=]+)=(.*)$/.exec(line);
        if (kv) {
          block[kv[1]] =
            !kv[1].startsWith('TAG:') && /^[0-9]+(\.[0-9]+)?$/.test(kv[2]) ? Number(kv[2]) : kv[2];
        }
      }
      line = lines.shift();
    }
    return block;
  };
  let line = lines.shift();
  while (line !== undefined) {
    if (/^\[stream/i.test(line)) data.streams.push(parseBlock('stream'));
    else if (/^\[chapter/i.test(line)) data.chapters.push(parseBlock('chapter'));
    else if (line.toLowerCase() === '[format]') data.format = parseBlock('format');
    line = lines.shift();
  }
  for (const target of [data.format, ...data.streams]) {
    for (const key of Object.keys(target)) {
      for (const [prefix, field] of [
        ['TAG:', 'tags'],
        ['DISPOSITION:', 'disposition'],
      ] as const) {
        if (!key.startsWith(prefix)) continue;
        const group = (target[field] ??= {}) as Section;
        group[key.slice(prefix.length)] = target[key];
        delete target[key];
      }
    }
  }
  return data;
}

/** 旧版里有、值不是 N/A 的字段，新版必须给出同样的值（已知差异除外） */
function assertMatchesLegacy(actual: Section, legacy: Section, where: string) {
  for (const [key, value] of Object.entries(legacy)) {
    if (value === 'N/A' || value === 'unknown') continue;
    // 文本输出里 displaymatrix 是多行的，fluent 只取到了空串；filename 现在只给文件名
    if (key === 'displaymatrix' || key === 'filename') continue;
    assert.ok(key in actual, `${where}.${key} 缺失（旧版为 ${JSON.stringify(value)}）`);
    assert.deepEqual(actual[key], value, `${where}.${key}`);
  }
}

test('info: 与旧版 fluent-ffmpeg 的形状和数值转换一致', { skip: ffmpegSkip }, async () => {
  for (const file of [video, rotated, chaptered]) {
    const { result, ctx } = await runOperation(info, { file: [file] });
    try {
      const data = result.data as Legacy;
      const legacy = fluentProbe(file);
      assert.equal(legacy.streams[0].codec_name, 'h264', '旧版解析器没有解析出内容');
      assert.equal(typeof legacy.format.duration, 'number');
      assert.deepEqual(result.files, []);
      assert.equal(data.streams.length, legacy.streams.length);
      data.streams.forEach((s, i) => assertMatchesLegacy(s, legacy.streams[i], `streams[${i}]`));
      assertMatchesLegacy(data.format, legacy.format, 'format');
    } finally {
      await ctx.cleanup();
    }
  }
});

test('info: 数值转换、旋转信息摊平、不暴露服务器路径', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(info, { file: [rotated] });
  try {
    const data = result.data as Legacy;
    const [v, a] = data.streams;
    assert.equal(v.codec_type, 'video');
    assert.equal(v.width, 320);
    assert.equal(v.r_frame_rate, '25/1');
    assert.equal(typeof v.duration, 'number');
    assert.equal(typeof v.bit_rate, 'number');
    assert.equal(v.rotation, 90);
    assert.ok(Array.isArray(v.side_data_list));
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.sample_rate, 48000);
    assert.equal(typeof (a.tags as Section).language, 'string');
    assert.equal(data.format.filename, 'rotated.mp4');
    assert.equal(typeof data.format.size, 'number');
    assert.ok(Math.abs((data.format.duration as number) - 2) < 0.1);
    assert.equal(typeof (data.format.tags as Section).minor_version, 'string', 'tags 保持字符串');
    assert.deepEqual(data.chapters, []);
  } finally {
    await ctx.cleanup();
  }
});

test('info: 返回章节，tags 里的数字仍是字符串', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(info, { file: [chaptered] });
  try {
    const data = result.data as Legacy;
    assert.equal(data.chapters.length, 2);
    assert.equal(data.chapters[1].start_time, 1);
    assert.equal(data.chapters[1].end_time, 2);
    assert.equal((data.chapters[0].tags as Section).title, 'Intro');
    assert.equal((data.format.tags as Section).title, 'Sample 123');
  } finally {
    await ctx.cleanup();
  }
});

test('info: 纯音频、图片、字幕文件都能解析', { skip: ffmpegSkip }, async () => {
  const files = [
    makeAudio(dir, 'tone.mp3'),
    makeImage(dir, 'pic.png', { size: '64x48' }),
    makeSrt(dir, 'subs.srt'),
  ];
  const types: string[] = [];
  for (const file of files) {
    const { result, ctx } = await runOperation(info, { file: [file] });
    try {
      const data = result.data as Legacy;
      types.push(String(data.streams[0]?.codec_type));
    } finally {
      await ctx.cleanup();
    }
  }
  assert.deepEqual(types, ['audio', 'video', 'subtitle']);
});

test('info: 不是媒体文件时给出中文错误', { skip: ffmpegSkip }, async () => {
  const bogus = path.join(dir, 'bogus.mp4');
  fs.writeFileSync(bogus, 'this is not a video');
  await expectRunError(info, { file: [bogus] }, {}, /无法解析文件，可能不是有效的媒体文件/);
});

test(
  'info: 不是媒体文件或空文件时返回 422（客户端的问题），信息里没有服务器路径',
  { skip: ffmpegSkip },
  async () => {
    const junk = path.join(dir, 'junk.mp4');
    fs.writeFileSync(junk, 'this is not a video');
    const empty = path.join(dir, 'empty.mp4');
    fs.writeFileSync(empty, '');
    const cases: [string, RegExp][] = [
      [junk, /无法解析文件，可能不是有效的媒体文件: .*junk\.mp4/],
      [empty, /文件是空的/],
    ];
    const tmp = os.tmpdir();
    for (const [file, message] of cases) {
      await assert.rejects(runOperation(info, { file: [file] }), (err: unknown) => {
        assert.ok(err instanceof HttpError, `${file}: 应是 HttpError，实际 ${String(err)}`);
        assert.equal(err.status, 422);
        assert.match(err.message, message);
        for (const leaked of [dir, tmp, tmp.split(path.sep).join('/')]) {
          assert.ok(!err.message.includes(leaked), `错误信息暴露了路径: ${err.message}`);
        }
        return true;
      });
    }
  },
);

test('info: 无参数，同步接口', () => {
  assert.equal(info.sync, true);
  assert.notEqual(info.chainable, true);
  assert.deepEqual(paramErrors(info, {}), []);
});

test('toLegacyProbe: 负数和分数保持字符串，side_data 不覆盖已有字段', () => {
  const data = toLegacyProbe({
    streams: [
      {
        index: 0,
        start_time: '-0.021333',
        duration: '10.5',
        r_frame_rate: '30000/1001',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90, index: 7 }],
      },
    ],
    format: { filename: '/srv/uploads/abc/input-0.mp4', size: '1024', tags: { track: '3' } },
  });
  const [s] = data.streams;
  assert.equal(s.start_time, '-0.021333');
  assert.equal(s.duration, 10.5);
  assert.equal(s.r_frame_rate, '30000/1001');
  assert.equal(s.rotation, '-90');
  assert.equal(s.index, 0);
  assert.equal(s.side_data_type, 'Display Matrix');
  assert.equal(data.format.filename, 'input-0.mp4');
  assert.equal(data.format.size, 1024);
  assert.deepEqual(data.format.tags, { track: '3' });
  assert.deepEqual(data.chapters, []);
});
