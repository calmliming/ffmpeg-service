import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteDashManifest, rewriteHlsPlaylist } from '../../../src/services/storage.service';

// 预签名模式下改写播放列表的纯文本部分；真实 FFmpeg 产物 + MinIO 的端到端验证在 s3.test.ts

/** 模拟签名：本批产物里的文件返回带签名的绝对地址，其余返回 undefined */
function signer(files: string[]) {
  const seen: string[] = [];
  const sign = (ref: string) => {
    seen.push(ref);
    return files.includes(ref)
      ? `https://s3.example.com/b/${ref}?X-Amz-Signature=abc&X-Amz-Expires=600`
      : undefined;
  };
  return { sign, seen };
}

const signed = (name: string) =>
  `https://s3.example.com/b/${name}?X-Amz-Signature=abc&X-Amz-Expires=600`;

test('HLS master：分档列表 URI 行、EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF 的 URI 属性都换成签名地址', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文, 音轨",DEFAULT=YES,URI="media_2.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=261410,RESOLUTION=160x120,CODECS="avc1.42c00a,mp4a.40.2",AUDIO="aud"',
    'media_0.m3u8',
    '',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe.m3u8"',
    '# 普通注释 URI="media_0.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
    'https://cdn.example.com/other.m3u8',
    '',
  ].join('\n');
  const { sign } = signer(['media_0.m3u8', 'media_2.m3u8', 'iframe.m3u8']);
  assert.equal(
    rewriteHlsPlaylist(master, sign),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文, 音轨",DEFAULT=YES,URI="${signed('media_2.m3u8')}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=261410,RESOLUTION=160x120,CODECS="avc1.42c00a,mp4a.40.2",AUDIO="aud"',
      signed('media_0.m3u8'),
      '',
      `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="${signed('iframe.m3u8')}"`,
      '# 普通注释 URI="media_0.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      'https://cdn.example.com/other.m3u8',
      '',
    ].join('\n'),
  );
});

test('HLS 分档列表：EXT-X-MAP 初始化分片和分片行改写，EXTINF 标题不动，CRLF 保留', () => {
  const variant = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-MAP:URI="360p_init.mp4"',
    '#EXTINF:1.000000,URI="360p_000.m4s"',
    '360p_000.m4s',
    '#EXTINF:1.000000,',
    '  360p_001.m4s  ',
    '#EXT-X-ENDLIST',
    '',
  ].join('\r\n');
  const { sign, seen } = signer(['360p_init.mp4', '360p_000.m4s', '360p_001.m4s']);
  assert.equal(
    rewriteHlsPlaylist(variant, sign),
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:1',
      `#EXT-X-MAP:URI="${signed('360p_init.mp4')}"`,
      '#EXTINF:1.000000,URI="360p_000.m4s"',
      signed('360p_000.m4s'),
      '#EXTINF:1.000000,',
      signed('360p_001.m4s'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\r\n'),
  );
  // 只把真正的引用交给签名
  assert.deepEqual(seen, ['360p_init.mp4', '360p_000.m4s', '360p_001.m4s']);
});

test('HLS：没有可签名的引用时内容逐字节不变', () => {
  const text = '#EXTM3U\n#EXT-X-MAP:URI="gone.mp4"\n#EXTINF:1,\nmissing.ts\n';
  assert.equal(rewriteHlsPlaylist(text, signer([]).sign), text);
});

test('DASH SegmentList：Initialization / SegmentURL 换成签名地址，& 按 XML 转义', () => {
  const mpd = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT3.0S">',
    '  <Period id="0">',
    '    <AdaptationSet id="0" contentType="video" mimeType="video/mp4">',
    '      <Representation id="0" bandwidth="1000" mediaStreamStructureId="1">',
    '        <SegmentList timescale="1000000" duration="1000000" startNumber="1">',
    '          <Initialization sourceURL="init-stream0.m4s" />',
    '          <SegmentURL media="chunk-stream0-00001.m4s" />',
    '          <SegmentURL media=\'a&amp;b.m4s\' indexRange="0-100" />',
    '        </SegmentList>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n');
  const { sign, seen } = signer(['init-stream0.m4s', 'chunk-stream0-00001.m4s', 'a&b.m4s']);
  const out = rewriteDashManifest(mpd, sign);
  const esc = (name: string) => signed(name).replace(/&/g, '&amp;');
  assert.ok(out.includes(`<Initialization sourceURL="${esc('init-stream0.m4s')}" />`), out);
  assert.ok(out.includes(`<SegmentURL media="${esc('chunk-stream0-00001.m4s')}" />`), out);
  assert.ok(out.includes(`<SegmentURL media='${esc('a&b.m4s')}' indexRange="0-100" />`), out);
  assert.ok(!/&(?!amp;)/.test(out), '没有未转义的 &');
  assert.ok(out.includes('mediaStreamStructureId="1"'), '名字以 media 开头的其他属性不动');
  assert.deepEqual(seen, ['init-stream0.m4s', 'chunk-stream0-00001.m4s', 'a&b.m4s']);
});

test('DASH SegmentBase：指向文件的 BaseURL 换成签名地址', () => {
  const mpd =
    '<MPD><Period><AdaptationSet><Representation id="0"><BaseURL>video_0.mp4</BaseURL>' +
    '<SegmentBase indexRange="800-900"><Initialization range="0-799"/></SegmentBase>' +
    '</Representation></AdaptationSet></Period></MPD>';
  const out = rewriteDashManifest(mpd, signer(['video_0.mp4']).sign);
  assert.ok(
    out.includes(`<BaseURL>${signed('video_0.mp4').replace(/&/g, '&amp;')}</BaseURL>`),
    out,
  );
});

test('DASH SegmentTemplate、目录形式的 BaseURL：无法逐个签名，报中文错误并提示 S3_PUBLIC_BASE_URL', () => {
  const template =
    '<MPD><Period><AdaptationSet><Representation id="0">' +
    '<SegmentTemplate initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" />' +
    '</Representation></AdaptationSet></Period></MPD>';
  assert.throws(() => rewriteDashManifest(template, signer([]).sign, 'manifest.mpd'), {
    message:
      'DASH 清单 manifest.mpd 用 SegmentTemplate 按模板拼分片地址，预签名链接无法逐个替换，播放器取分片会被拒绝（403）；请设置 S3_PUBLIC_BASE_URL（公开读的存储桶或 CDN 地址），或改用本地存储',
  });
  const dirBase =
    '<MPD><BaseURL>video/</BaseURL><Period><SegmentList><SegmentURL media="a.m4s"/></SegmentList></Period></MPD>';
  assert.throws(() => rewriteDashManifest(dirBase, signer(['a.m4s']).sign, 'x.mpd'), {
    message: /^DASH 清单 x\.mpd 的 BaseURL（video\/）不是本次产物里的文件.*S3_PUBLIC_BASE_URL/,
  });
});
