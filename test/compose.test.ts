/**
 * 合成接口集成测试：23 个视频 + 1 首背景音乐
 * 运行方式：pnpm tsx test/compose.test.ts
 */

const BASE_URL = process.env.API_URL ?? 'http://localhost:9527';
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

const MUSIC_URL =
  'https://cdn.musegen.ai/music/1776221983648_39f4a2a57931400796ca1a695e9cb094.wav';

const VIDEO_URLS = [
  'https://cdn.musegen.ai/video/1776222782844_e05a1490170047599cf727ed9b106af5.mp4',
  'https://cdn.musegen.ai/video/1776222803221_287161ef21ac46bd9845b8dcb22d615f.mp4',
  'https://cdn.musegen.ai/video/1776222941128_2aabb354d2f246b2a0bf264efb406232.mp4',
  'https://cdn.musegen.ai/video/1776223148972_56677979ea0f421d8b8f43345a9c3771.mp4',
  'https://cdn.musegen.ai/video/1776222940545_d6dad08508ba4e00a8f5bab93f62163b.mp4',
  'https://cdn.musegen.ai/video/1776223005390_782f0ded690443598e72602cfbb03b5f.mp4',
  'https://cdn.musegen.ai/video/1776223082300_d347b6b9cb5145ba96ba7a1b23d9e5e9.mp4',
  'https://cdn.musegen.ai/video/1776223071822_080726aa3abf47cd886691481d619dcd.mp4',
  'https://cdn.musegen.ai/video/1776224277187_e551d27d28e74a11a636b9a9440d1c65.mp4',
  'https://cdn.musegen.ai/video/1776223144754_6820522a8a034f669abd1b998542e73a.mp4',
  'https://cdn.musegen.ai/video/1776223339714_a6128cdc65614a78adde0c86e80d6f6a.mp4',
  'https://cdn.musegen.ai/video/1776223826067_1bf9a6b37b264aa3b94c1871de8a96bf.mp4',
  'https://cdn.musegen.ai/video/1776223404390_5cda4299e0404cf09092da88e3cdce67.mp4',
  'https://cdn.musegen.ai/video/1776223249934_7b069e87984f42ad8a4e72eb8d5cfba7.mp4',
  'https://cdn.musegen.ai/video/1776224341351_7e95acf314ee45328a0e4c39fb04bea0.mp4',
  'https://cdn.musegen.ai/video/1776223451161_26de3687894e4ab0b04d4fb3f16f5233.mp4',
  'https://cdn.musegen.ai/video/1776223524852_0425de2251214425a2b6ee4b807fe734.mp4',
  'https://cdn.musegen.ai/video/1776223571621_465525e9ccb94528ad28c172e71fc625.mp4',
  'https://cdn.musegen.ai/video/1776224000073_7199743988fc4460a8d80ad00ef6cf44.mp4',
  'https://cdn.musegen.ai/video/1776222883027_0744f0ea08e943caaf80b1c7c9759a90.mp4',
  'https://cdn.musegen.ai/video/1776222904007_0b5284b0b1224e3aada98d4cd0437299.mp4',
  'https://cdn.musegen.ai/video/1776223712609_9ea836861e464256b71db91152adeec1.mp4',
  'https://cdn.musegen.ai/video/1776225126343_e121543f295b45cf97c18db4c4d4b5ae.mp4',
];

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error(`\n✗ FAIL: ${message}`);
    process.exit(1);
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitComposeTask() {
  const body = {
    videos: VIDEO_URLS,
    music: MUSIC_URL,
    musicVolume: 0.8,
    muteOriginalAudio: false,
  };

  console.log(`\n→ POST ${BASE_URL}/api/compose`);
  console.log(`  videos: ${VIDEO_URLS.length} 个`);
  console.log(`  music:  ${MUSIC_URL}`);

  const res = await fetch(`${BASE_URL}/api/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json: any = await res.json();
  assert(res.ok, `提交任务失败 HTTP ${res.status}: ${JSON.stringify(json)}`);
  assert(json.success === true, `响应 success 应为 true，实际：${JSON.stringify(json)}`);
  assert(typeof json.data?.taskId === 'string', `响应缺少 taskId：${JSON.stringify(json)}`);

  console.log(`✓ 任务已创建，taskId = ${json.data.taskId}`);
  return json.data.taskId as string;
}

async function pollTaskUntilDone(taskId: string) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastProgress = -1;
  let lastStatus = '';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
    const json: any = await res.json();

    assert(res.ok, `查询任务失败 HTTP ${res.status}: ${JSON.stringify(json)}`);
    assert(json.success === true, `查询响应 success 应为 true`);

    const task = json.data;
    const status: string = task.status;
    const progress: number = task.progress ?? 0;
    const elapsed: number = task.elapsedSeconds ?? 0;

    if (status !== lastStatus || progress !== lastProgress) {
      console.log(
        `  [${new Date().toLocaleTimeString()}] status=${status}  progress=${progress}%  elapsed=${elapsed}s` +
        (task.currentVideoIndex !== undefined
          ? `  video=${task.currentVideoIndex}/${task.totalVideos}`
          : ''),
      );
      lastStatus = status;
      lastProgress = progress;
    }

    if (status === 'completed') {
      return task;
    }

    if (status === 'failed') {
      assert(false, `任务失败：${task.error ?? '未知错误'}`);
    }
  }

  assert(false, `任务超时（超过 ${TIMEOUT_MS / 1000}s 仍未完成）`);
}

async function main() {
  console.log('=== compose 合成接口集成测试 ===');
  console.log(`目标服务: ${BASE_URL}`);
  assert(VIDEO_URLS.length === 23, `视频数量应为 23，实际 ${VIDEO_URLS.length}`);

  const taskId = await submitComposeTask();
  console.log('\n→ 轮询任务进度...');
  const task = await pollTaskUntilDone(taskId);

  assert(task.status === 'completed', `最终状态应为 completed`);
  assert(Array.isArray(task.downloadUrl) && task.downloadUrl.length > 0, `缺少 downloadUrl`);

  console.log('\n✓ 测试通过！');
  console.log(`  耗时:        ${task.elapsedSeconds}s`);
  console.log(`  下载链接:`);
  for (const url of task.downloadUrl) {
    console.log(`    ${BASE_URL}${url}`);
  }
}

main().catch(err => {
  console.error('\n✗ 未捕获错误:', err);
  process.exit(1);
});
