import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { subtitles } from '../../../../src/operations/compositing/subtitles';
import { toAssColor } from '../../../../src/operations/compositing/colors';
import {
  fontFileFamily,
  pickFontFamily,
  readFontFamilies,
} from '../../../../src/operations/compositing/font-family';
import {
  assScriptInfo,
  decodeSubtitle,
  detectSubtitleFormat,
  shiftSubtitle,
} from '../../../../src/operations/compositing/subtitle-file';
import { probeMedia, probeRaw } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeSrt, makeTempDir } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import {
  brightPixels,
  differentPixels,
  disguise,
  grayArea,
  makeBlackVideo,
  runFails,
  streamsOf,
} from './fixtures';

let dir = '';
let video = '';
let oddSilent = '';
let srt = '';
let ass = '';
let vtt = '';
let mkvWithSubs = '';

const TOP = { x: 0, y: 0, w: 320, h: 80 };
const BOTTOM = { x: 0, y: 160, w: 320, h: 80 };

// 顶部居中（小键盘 8）、PlayResY 480 的 ASS，不传任何样式参数时应保留在顶部
const ASS_TOP = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 480

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,顶部 ASS 字幕
`;

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-subs-');
  // 扩展名故意不可信：URL 下载的文件可能叫任何名字
  video = disguise(makeBlackVideo(dir, 'black.mp4'));
  srt = disguise(
    makeSrt(dir, 'zh.srt', [
      { start: '00:00:00,000', end: '00:00:02,000', text: '中文字幕测试 Subtitle' },
    ]),
    '.txt',
  );
  ass = path.join(dir, 'top.ass');
  fs.writeFileSync(ass, ASS_TOP);
  vtt = path.join(dir, 'cue.vtt');
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00.000 --> 00:02.000\nWebVTT 字幕\n');

  // 奇数尺寸、无音轨（yuv444p 才能编码奇数尺寸）
  oddSilent = path.join(dir, 'odd.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=321x241:rate=25:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv444p',
    oddSilent,
  ]);

  // 已经带一条 SRT 字幕轨和一个附件的 mkv
  const note = path.join(dir, 'note.txt');
  fs.writeFileSync(note, 'attachment');
  mkvWithSubs = path.join(dir, 'with-subs.mkv');
  generate([
    '-i',
    video,
    '-i',
    srt,
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'srt',
    '-attach',
    note,
    '-metadata:s:t',
    'mimetype=text/plain',
    mkvWithSubs,
  ]);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('burn：SRT 字幕烧录在画面底部，画面尺寸、时长、音轨不变', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(subtitles, { file: [video], subtitle: [srt] }, {});
  try {
    assert.equal(result.files.length, 1);
    const out = result.files[0];
    assert.ok(out.endsWith('.mp4'));
    const media = await probeMedia(out);
    assert.equal(media.video?.codec, 'h264');
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 240);
    assert.ok(Math.abs(media.duration - 2) < 0.15, `时长 ${media.duration}`);
    assert.equal(media.audio?.codec, 'aac');
    assert.ok(brightPixels(out, 1, BOTTOM) > 30, '底部应当有字幕');
    assert.equal(brightPixels(out, 1, TOP), 0, '顶部不应有字幕');
    assert.ok(ctx.progressCalls.length > 0);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('burn：position=top 和样式参数', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [video], subtitle: [srt] },
    {
      position: 'top',
      fontSize: '28',
      fontColor: 'yellow',
      outlineColor: '#FF0000',
      outline: '2',
      bold: 'true',
      marginV: '10',
    },
  );
  try {
    const out = result.files[0];
    assert.ok(brightPixels(out, 1, TOP) > 100, '顶部应当有字幕');
    assert.equal(brightPixels(out, 1, BOTTOM), 0, '底部不应有字幕');
  } finally {
    await ctx.cleanup();
  }
});

test('burn：text 直接传 WebVTT，offset 推迟字幕', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [video] },
    { text: 'WEBVTT\n\n00:00.000 --> 00:01.000\n推迟一秒\n', offset: 1, fontSize: 30 },
  );
  try {
    const out = result.files[0];
    assert.equal(brightPixels(out, 0.5, BOTTOM), 0, '0.5 秒时字幕还没出现');
    assert.ok(brightPixels(out, 1.5, BOTTOM) > 30, '1.5 秒时应当显示字幕');
  } finally {
    await ctx.cleanup();
  }
});

test('burn：ASS 字幕保留自身样式（顶部）', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(subtitles, { file: [video], subtitle: [ass] }, {});
  try {
    const out = result.files[0];
    assert.ok(brightPixels(out, 1, TOP) > 100, 'ASS 指定了顶部对齐');
    assert.equal(brightPixels(out, 1, BOTTOM), 0);
  } finally {
    await ctx.cleanup();
  }
});

test('burn：ASS 显式传 position 时覆盖原样式', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [video], subtitle: [ass] },
    { position: 'bottom', overrideFont: true },
  );
  try {
    const out = result.files[0];
    assert.ok(brightPixels(out, 1, BOTTOM) > 100);
    assert.equal(brightPixels(out, 1, TOP), 0);
  } finally {
    await ctx.cleanup();
  }
});

test('burn：无音轨、奇数尺寸的视频输出偶数尺寸且没有音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [oddSilent], subtitle: [vtt] },
    { container: 'mkv' },
  );
  try {
    const out = result.files[0];
    assert.ok(out.endsWith('.mkv'));
    const media = await probeMedia(out);
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 240);
    assert.equal(media.audio, undefined);
    assert.ok(Math.abs(media.duration - 1) < 0.15);
  } finally {
    await ctx.cleanup();
  }
});

test('soft：mp4 封装 mov_text 字幕轨并写语言标签，画面流复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [video], subtitle: [srt] },
    { mode: 'soft', language: 'CHI', fontSize: 30 },
  );
  try {
    const out = result.files[0];
    const streams = await streamsOf(out);
    const v = streams.find((s) => s.codec_type === 'video');
    const subs = streams.filter((s) => s.codec_type === 'subtitle');
    assert.equal(v?.codec_name, 'h264');
    assert.equal(v?.nb_frames, '50', '画面应当流复制，帧数不变');
    assert.ok(streams.some((s) => s.codec_type === 'audio'));
    assert.equal(subs.length, 1);
    assert.equal(subs[0].codec_name, 'mov_text');
    assert.equal(subs[0].tags?.language, 'chi');
    // 画面没有被烧录
    assert.equal(brightPixels(out, 1, BOTTOM), 0);
    assert.ok(ctx.logs.some((l) => l.includes('soft 模式忽略样式参数: fontSize')));
  } finally {
    await ctx.cleanup();
  }
});

test('soft：mkv 保留原有字幕轨和附件，WebVTT 转成 SRT', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [mkvWithSubs], subtitle: [vtt] },
    { mode: 'soft', container: 'mkv', language: 'eng' },
  );
  try {
    const streams = await streamsOf(result.files[0]);
    const subs = streams.filter((s) => s.codec_type === 'subtitle');
    assert.deepEqual(
      subs.map((s) => s.codec_name),
      ['subrip', 'subrip'],
    );
    assert.equal(subs[1].tags?.language, 'eng');
    assert.equal(streams.filter((s) => s.codec_type === 'attachment').length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'soft：mp4 输入原有的 mov_text 字幕轨在 mkv 里转成 SRT 保留',
  { skip: ffmpegSkip },
  async () => {
    // 回归：原有字幕轨一律 -c:s copy，Matroska 装不下 mov_text，写文件头时失败
    const withMovText = path.join(dir, 'with-movtext.mp4');
    generate([
      '-i',
      video,
      '-i',
      srt,
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-c:s',
      'mov_text',
      '-metadata:s:s:0',
      'language=eng',
      '-f',
      'mp4',
      withMovText,
    ]);
    const { result, ctx } = await runOperation(
      subtitles,
      { file: [withMovText], subtitle: [vtt] },
      { mode: 'soft', container: 'mkv', language: 'chi' },
    );
    try {
      const out = result.files[0];
      const streams = await streamsOf(out);
      const subs = streams.filter((s) => s.codec_type === 'subtitle');
      assert.deepEqual(
        subs.map((s) => s.codec_name),
        ['subrip', 'subrip'],
      );
      assert.equal(subs[0].tags?.language, 'eng', '原有字幕轨的语言保留');
      assert.equal(subs[1].tags?.language, 'chi');
      const original = execFileSync(
        config.ffmpegPath,
        ['-v', 'error', '-i', out, '-map', '0:s:0', '-f', 'srt', '-'],
        { encoding: 'utf8' },
      );
      assert.ok(original.includes('中文字幕测试 Subtitle'), original);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('soft：mkv 里的 ASS 原样复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    subtitles,
    { file: [video], subtitle: [ass] },
    { mode: 'soft', container: 'mkv' },
  );
  try {
    const streams = await streamsOf(result.files[0]);
    const subs = streams.filter((s) => s.codec_type === 'subtitle');
    assert.deepEqual(
      subs.map((s) => s.codec_name),
      ['ass'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('字幕内容无法识别时任务失败', { skip: ffmpegSkip }, async () => {
  const junk = path.join(dir, 'junk.srt');
  fs.writeFileSync(junk, 'this is not a subtitle file\n');
  await runFails(subtitles, { file: [video], subtitle: [junk] }, {}, /字幕格式无法识别/);
});

test('输入不是视频时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(subtitles, { file: [srt], subtitle: [vtt] }, {}, /视频无法解析|不包含视频画面/);
});

test('取消任务时 ffmpeg 被终止', { skip: ffmpegSkip }, async () => {
  const long = makeBlackVideo(dir, 'long.mp4', { size: '640x360', duration: 20 });
  const controller = new AbortController();
  const ctx = createTestContext({ file: [long], subtitle: [srt] }, { signal: controller.signal });
  try {
    const params = subtitles.params.parse({});
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('用户取消')), 300);
    await assert.rejects(subtitles.run(ctx, params), /用户取消/);
    assert.ok(Date.now() - started < 5000, '取消后应当很快结束');
  } finally {
    await ctx.cleanup();
  }
});

test('参数校验：字幕来源', () => {
  assert.deepEqual(paramErrors(subtitles, {}), [
    '缺少字幕：请上传 subtitle 文件（或传 subtitleUrl），或用 text 直接传字幕内容',
  ]);
  assert.deepEqual(
    paramErrors(
      subtitles,
      { text: '1\n00:00:00,000 --> 00:00:01,000\nhi\n' },
      { file: 1, subtitle: 1 },
    ),
    ['subtitle 文件和 text 只能二选一'],
  );
  assert.match(paramErrors(subtitles, { text: 'hello' })[0], /不是有效的 SRT 或 WebVTT/);
  const big = `1\n00:00:00,000 --> 00:00:01,000\n${'字'.repeat(25_000)}\n`;
  assert.match(paramErrors(subtitles, { text: big })[0], /不能超过 60 KB/);
  // 空白字段视为没传
  assert.deepEqual(paramErrors(subtitles, { text: '   ' }, { file: 1, subtitle: 1 }), []);
});

test('参数校验：样式和封装参数', () => {
  const provided = { file: 1, subtitle: 1 };
  assert.deepEqual(paramErrors(subtitles, { mode: 'hard' }, provided), ['mode 只能是 burn / soft']);
  assert.deepEqual(paramErrors(subtitles, { outline: '11' }, provided), [
    'outline 必须是 0 到 10 之间的数字',
  ]);
  assert.deepEqual(paramErrors(subtitles, { position: 'left' }, provided), [
    'position 只能是 bottom / top / middle',
  ]);
  assert.match(
    paramErrors(subtitles, { fontColor: 'notacolor' }, provided)[0],
    /fontColor 必须是颜色名/,
  );
  assert.match(paramErrors(subtitles, { language: 'zh' }, provided)[0], /ISO 639-2/);
  assert.match(paramErrors(subtitles, { language: 'c:i' }, provided)[0], /ISO 639-2/);
  assert.deepEqual(paramErrors(subtitles, { container: 'avi' }, provided), [
    'container 只能是 mp4 / mkv',
  ]);
  assert.deepEqual(paramErrors(subtitles, { marginV: '1.5' }, provided), [
    'marginV 必须是 0 到 4000 之间的整数',
  ]);
  assert.deepEqual(
    paramErrors(subtitles, { fontSize: '40', fontColor: 'white@0.5', bold: 'yes' }, provided),
    [],
  );
});

test('字幕解码：BOM、UTF-16、GBK 自动识别', () => {
  const srtText = '1\n00:00:00,000 --> 00:00:01,000\n';
  // 「简体中文」的 GBK 字节
  const gbk = Buffer.concat([
    Buffer.from(srtText.replace(/\n/g, '\r\n')),
    Buffer.from([0xbc, 0xf2, 0xcc, 0xe5, 0xd6, 0xd0, 0xce, 0xc4]),
  ]);
  assert.equal(decodeSubtitle(gbk), `${srtText}简体中文`);
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${srtText}中文`)]);
  assert.equal(decodeSubtitle(utf8Bom), `${srtText}中文`);
  const utf16le = Buffer.from(`${srtText}中文`, 'utf16le');
  assert.equal(decodeSubtitle(utf16le), `${srtText}中文`);
  assert.equal(
    decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le])),
    `${srtText}中文`,
  );
  assert.equal(decodeSubtitle(Buffer.from('中文', 'utf8'), 'utf-8'), '中文');
});

test('字幕格式按内容识别', () => {
  assert.equal(detectSubtitleFormat('\uFEFF1\n00:00:01,000 --> 00:00:02,000\nhi'), 'srt');
  assert.equal(detectSubtitleFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nhi'), 'vtt');
  assert.equal(detectSubtitleFormat(ASS_TOP), 'ass');
  assert.equal(detectSubtitleFormat('[Script Info]\nTitle: x\n'), undefined);
  assert.equal(detectSubtitleFormat('hello world'), undefined);
  assert.deepEqual(assScriptInfo(ASS_TOP), { playResY: 480, scaledBorder: false });
  assert.deepEqual(assScriptInfo('[Script Info]\nPlayResX: 1280\n'), {
    playResY: 1024,
    scaledBorder: false,
  });
});

test('shiftSubtitle：SRT 平移，0 秒之前的丢弃、跨过 0 秒的截到 0', () => {
  const srtText = [
    '1',
    '00:00:00,000 --> 00:00:01,000',
    'A',
    '',
    '2',
    '00:00:01,000 --> 00:00:02,500',
    'B',
    '',
    '3',
    '01:59:59,900 --> 02:00:00,100',
    'C',
  ].join('\n');
  const back = shiftSubtitle(srtText, 'srt', -1.5);
  assert.equal(back.cues, 2);
  assert.equal(
    back.text,
    ['2', '00:00:00,000 --> 00:00:01,000', 'B', '', '3', '01:59:58,400 --> 01:59:58,600', 'C'].join(
      '\n',
    ),
  );
  const later = shiftSubtitle(srtText, 'srt', 0.25);
  assert.ok(later.text.startsWith('1\n00:00:00,250 --> 00:00:01,250\nA'));
  assert.equal(shiftSubtitle(srtText, 'srt', -8000).cues, 0);
});

test('shiftSubtitle：WebVTT 保留头部、NOTE 和 cue 设置', () => {
  const vttText = [
    'WEBVTT',
    '',
    'NOTE 注释',
    '',
    'intro',
    '00:01.000 --> 00:02.000 align:start position:10%',
    '第一句',
  ].join('\n');
  const shifted = shiftSubtitle(vttText, 'vtt', 0.5);
  assert.equal(shifted.cues, 1);
  assert.equal(
    shifted.text,
    [
      'WEBVTT',
      '',
      'NOTE 注释',
      '',
      'intro',
      '00:00:01.500 --> 00:00:02.500 align:start position:10%',
      '第一句',
    ].join('\n'),
  );
});

test('shiftSubtitle：ASS 按 Format 行找时间字段，Text 里的逗号不受影响', () => {
  const shifted = shiftSubtitle(ASS_TOP.replace('顶部 ASS 字幕', '你好,{\\k20}世界'), 'ass', 1.25);
  assert.equal(shifted.cues, 1);
  assert.ok(
    shifted.text.includes('Dialogue: 0,0:00:01.25,0:00:03.25,Default,,0,0,0,,你好,{\\k20}世界'),
  );
  assert.ok(shifted.text.includes('Style: Default,Arial,40'), '样式行原样保留');
  // SSA v4：第一个字段是 Marked
  const ssa = [
    '[Script Info]',
    'ScriptType: v4.00',
    '',
    '[Events]',
    'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: Marked=0,0:00:00.50,0:00:01.00,Default,,0000,0000,0000,,丢弃',
    'Dialogue: Marked=0,0:00:01.00,0:00:03.00,Default,,0000,0000,0000,,保留',
  ].join('\n');
  const back = shiftSubtitle(ssa, 'ass', -1);
  assert.equal(back.cues, 1);
  assert.ok(
    back.text.includes('Dialogue: Marked=0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,保留'),
  );
  assert.ok(!back.text.includes('丢弃'));
});

test('soft：负数 offset 不产生负时间戳，也不挪动画面', { skip: ffmpegSkip }, async () => {
  for (const container of ['mp4', 'mkv']) {
    const { result, ctx } = await runOperation(
      subtitles,
      { file: [video], subtitle: [srt] },
      { mode: 'soft', container, offset: '-0.5' },
    );
    try {
      const out = result.files[0];
      const packets = execFileSync(
        config.ffprobePath,
        [
          '-v',
          'error',
          '-select_streams',
          's',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          out,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split(/\r?\n/)
        .map(Number);
      assert.ok(packets.length > 0, container);
      assert.ok(Math.min(...packets) >= 0, `${container} 字幕时间戳 ${packets.join(',')}`);
      const raw = await probeRaw(out);
      const v = (raw.streams as { codec_type?: string; start_time?: string }[]).find(
        (s) => s.codec_type === 'video',
      );
      assert.ok(Number(v?.start_time) < 0.1, `${container} 画面起点 ${v?.start_time}`);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('offset 让所有字幕落在 0 秒之前时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(
    subtitles,
    { file: [video], subtitle: [srt] },
    { offset: -10 },
    /平移 -10 秒后没有剩下任何字幕/,
  );
});

test('颜色转换成 ASS 的 &HAABBGGRR', () => {
  assert.equal(toAssColor('white'), '&H00FFFFFF');
  assert.equal(toAssColor('red'), '&H000000FF');
  assert.equal(toAssColor('0x112233'), '&H00332211');
  assert.equal(toAssColor('0xFF0000@0.5'), '&H800000FF');
  assert.equal(toAssColor('black@0'), '&HFF000000');
  // 0xRRGGBBAA 的 AA 是不透明度
  assert.equal(toAssColor('0x00FF00FF'), '&H0000FF00');
  assert.throws(() => toAssColor('bogus'), /无法识别的颜色/);
});

test('读出字体文件的英文族名', { skip: !fs.existsSync('C:/Windows/Fonts/msyh.ttc') }, async () => {
  assert.equal(await pickFontFamily('C:/Windows/Fonts/msyh.ttc'), 'Microsoft YaHei');
  assert.equal(await pickFontFamily(path.join(__dirname, 'fixtures.ts')), undefined);
});

/** 只有 name 表的最小字体文件（一个族名时是 TrueType，多个时是 TTC 字体集合），只用来测试族名读取 */
function fakeFont(families: string[]): Buffer {
  const face = (family: string, base: number) => {
    const text = Buffer.from(family, 'utf16le').swap16();
    const name = Buffer.alloc(18 + text.length);
    // name 表：format 0、1 条记录、字符串区从 18 字节开始；记录是 Windows / Unicode BMP / 英语（美国）/ 族名
    [0, 1, 18, 3, 1, 0x409, 1, text.length, 0].forEach((v, i) => name.writeUInt16BE(v, i * 2));
    text.copy(name, 18);
    const header = Buffer.alloc(28);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(1, 4);
    header.write('name', 12, 'latin1');
    header.writeUInt32BE(base + header.length, 20);
    header.writeUInt32BE(name.length, 24);
    return Buffer.concat([header, name]);
  };
  if (families.length === 1) return face(families[0], 0);
  const head = Buffer.alloc(12 + 4 * families.length);
  head.write('ttcf', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(families.length, 8);
  const faces: Buffer[] = [];
  let offset = head.length;
  families.forEach((family, i) => {
    head.writeUInt32BE(offset, 12 + 4 * i);
    const buf = face(family, offset);
    faces.push(buf);
    offset += buf.length;
  });
  return Buffer.concat([head, ...faces]);
}

/** 临时改字体配置跑 fn，结束后恢复 */
async function withFontConfig<T>(file: string, name: string, fn: () => Promise<T>): Promise<T> {
  const saved = { file: config.fontFile, name: config.fontName };
  config.fontFile = file;
  config.fontName = name;
  try {
    return await fn();
  } finally {
    config.fontFile = saved.file;
    config.fontName = saved.name;
  }
}

test('fontFileFamily：FONT_NAME 只在字体文件里有这个族时生效', async () => {
  const tmp = makeTempDir('ffsvc-font-');
  try {
    const ttc = path.join(tmp, 'fake.ttc');
    fs.writeFileSync(ttc, fakeFont(['Fake Sans JP', 'Fake Sans SC']));
    const ttf = path.join(tmp, 'fake.ttf');
    fs.writeFileSync(ttf, fakeFont(['Fake Kai']));
    assert.deepEqual(await readFontFamilies(ttc), ['Fake Sans JP', 'Fake Sans SC']);
    assert.equal(await fontFileFamily(ttc), 'Fake Sans SC', '字体集合里优先简体中文');
    assert.equal(
      await fontFileFamily(ttc, 'fake sans jp'),
      'Fake Sans JP',
      'FONT_NAME 挑字体集合里的一个',
    );
    assert.equal(await fontFileFamily(ttc, 'Noto Sans CJK SC'), 'Fake Sans SC');
    assert.equal(await fontFileFamily(ttf, 'Noto Sans CJK SC'), 'Fake Kai');
    assert.equal(await fontFileFamily(path.join(__dirname, 'fixtures.ts'), 'Any'), undefined);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test(
  'burn：FONT_FILE 优先于 FONT_NAME（Docker 镜像默认带 FONT_NAME）',
  { skip: ffmpegSkip },
  async () => {
    // 回归：FONT_NAME 一设置就直接写进 FontName，挂载的 FONT_FILE 只放进了 fontsdir，从来没被选中
    const fontFile = path.join(dir, 'fake.ttc');
    fs.writeFileSync(fontFile, fakeFont(['Fake Sans JP', 'Fake Sans SC']));
    const filterOf = (fontName: string) =>
      withFontConfig(fontFile, fontName, async () => {
        const ctx = createTestContext({ file: [video], subtitle: [srt] });
        const calls: string[][] = [];
        // 只看生成的命令：假字体 libass 加载不了
        ctx.ffmpeg = async (args) => {
          calls.push(args);
          return { stderr: '' };
        };
        try {
          await subtitles.run(ctx, subtitles.params.parse({}));
          const args = calls[0];
          const vf = args[args.indexOf('-vf') + 1];
          assert.ok(fs.existsSync(path.join(ctx.workDir, 'fonts')), '字体文件放进 workDir/fonts');
          return vf;
        } finally {
          await ctx.cleanup();
        }
      });
    const docker = await filterOf('Noto Sans CJK SC');
    assert.match(docker, /fontsdir=fonts/);
    assert.match(docker, /FontName=Fake Sans SC[,']/);
    assert.match(await filterOf(''), /FontName=Fake Sans SC[,']/);
    assert.match(await filterOf('Fake Sans JP'), /FontName=Fake Sans JP[,']/);
  },
);

const KAITI = 'C:/Windows/Fonts/simkai.ttf';
test(
  'burn：FONT_FILE=楷体、FONT_NAME=微软雅黑时画面上是楷体（真实渲染）',
  { skip: ffmpegSkip || !fs.existsSync(KAITI) || !fs.existsSync('C:/Windows/Fonts/msyh.ttc') },
  async () => {
    const render = (file: string, name: string) =>
      withFontConfig(file, name, async () => {
        const { result, ctx } = await runOperation(
          subtitles,
          { file: [video], subtitle: [srt] },
          { fontSize: 24 },
        );
        try {
          return grayArea(result.files[0], 1, BOTTOM);
        } finally {
          await ctx.cleanup();
        }
      });
    const kaiti = await render(KAITI, '');
    const yahei = await render('', 'Microsoft YaHei');
    const both = await render(KAITI, 'Microsoft YaHei');
    const apart = differentPixels(kaiti, yahei);
    assert.ok(apart > 100, `楷体和雅黑的字形应当明显不同（${apart}）`);
    assert.ok(differentPixels(both, kaiti) < apart / 10, '应当用 FONT_FILE 的楷体渲染');
  },
);
