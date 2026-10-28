import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { config } from '../../../src/config';
import { getOperation } from '../../../src/operations';
import { mapLegacyJob, type LegacyJobPayload } from '../../../src/services/queue.service';

// 升级上线时 Redis 里可能还排着旧版（fluent-ffmpeg，commit 92b3181）入队的 job。
// 这里用旧路由真实写入的 payload 形状，确认它们都能映射到注册表里的新操作，而不是升级后全部失败
const up = (name: string) => path.join(config.uploadDir, name);

const LEGACY_JOBS: { job: LegacyJobPayload; inputs: Record<string, number> }[] = [
  {
    job: {
      taskId: 't',
      type: 'transcode',
      inputPath: up('a.mp4'),
      options: { format: 'webm', resolution: '1280x720', fps: 30, videoBitrate: '1000k' },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'trim',
      inputPath: up('a.mp4'),
      options: { startTime: '00:00:05', duration: 10 },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'trim',
      inputPath: up('a.mp4'),
      options: { startTime: '5', endTime: '00:00:20' },
    },
    inputs: { file: 1 },
  },
  { job: { taskId: 't', type: 'merge', inputPaths: [up('a.mp4'), up('b.mp4')] }, inputs: {} },
  {
    job: { taskId: 't', type: 'extract-audio', inputPath: up('a.mp4'), format: 'mp3' },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'watermark',
      inputPath: up('a.mp4'),
      options: { text: 'Hello', position: 'bottom-right', fontSize: 24, fontColor: 'white' },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'watermark',
      inputPath: up('a.mp4'),
      options: { image: up('logo.png'), position: 'top-left' },
    },
    inputs: { file: 1, image: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'screenshot',
      inputPath: up('a.mp4'),
      options: { timestamps: ['1', '00:00:02', '50%'] },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'thumbnail',
      inputPath: up('a.mp4'),
      options: { count: 3, size: '320x240' },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'gif',
      inputPath: up('a.mp4'),
      options: { startTime: '0', duration: 3, width: 320, fps: 10 },
    },
    inputs: { file: 1 },
  },
  {
    job: {
      taskId: 't',
      type: 'compose',
      options: {
        videos: ['https://example.com/a.mp4', 'https://example.com/b.mp4'],
        music: 'https://example.com/m.mp3',
        musicVolume: 0.5,
        muteOriginalAudio: true,
      },
    },
    inputs: { videos: 2, music: 1 },
  },
];

test('旧版 job：注册表里的同名操作都能接住旧路由写入的 payload', () => {
  for (const { job, inputs } of LEGACY_JOBS) {
    const resolved = mapLegacyJob(job, getOperation);
    assert.ok(!('error' in resolved), `${job.type}: ${'error' in resolved ? resolved.error : ''}`);
    assert.equal(resolved.payload.op, job.type);
    assert.equal(resolved.payload.taskId, 't');
    for (const [slot, count] of Object.entries(inputs)) {
      assert.equal(resolved.payload.inputs[slot]?.length, count, `${job.type} 的 ${slot}`);
    }
    // 上传文件始终是本地路径，compose 的素材始终是链接
    for (const items of Object.values(resolved.payload.inputs)) {
      for (const item of items) {
        if (job.type === 'compose') assert.ok('url' in item);
        else assert.ok('path' in item);
      }
    }
  }
});

test('旧版 job：merge 的 inputPaths 落到多文件槽，compose 的链接按原字段名落到输入槽', () => {
  const merge = mapLegacyJob(
    { taskId: 'm', type: 'merge', inputPaths: [up('a.mp4'), up('b.mp4'), up('c.mp4')] },
    getOperation,
  );
  assert.ok(!('error' in merge));
  const [slot, items] = Object.entries(merge.payload.inputs)[0];
  assert.equal(
    getOperation('merge')!.inputs.find((s) => s.name === slot)!.multiple !== undefined,
    true,
  );
  assert.equal(items.length, 3);

  const info = mapLegacyJob({ taskId: 'i', type: 'info', inputPath: up('a.mp4') }, getOperation);
  // info 一直是同步接口，旧版也从未入队
  assert.ok('error' in info);
});
