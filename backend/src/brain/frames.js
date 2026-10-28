import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeFetch } from '../http/safeFetch.js';
import { normalizeImage } from './imageUtils.js';

// ffmpeg-static ships a binary for Windows, macOS and Linux; FFMPEG_PATH or a system ffmpeg also work.
export async function resolveFfmpeg(configured) {
  if (configured) return configured;
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default) return mod.default;
  } catch {
    // optional dependency not installed
  }
  return 'ffmpeg';
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() || 'no output'}`));
    });
  });
}

// Downloads a video (SSRF-safe, size-capped) and extracts one frame every N seconds.
export function createFrameSampler({ config, fetchVideo }) {
  const { frames } = config;
  const download = fetchVideo ?? (async (url) => (await safeFetch(url, { accept: 'video/*', timeoutMs: 30_000, maxBytes: frames.maxVideoBytes })).body);
  let ffmpegPath = null;

  return {
    async sample(videoUrl) {
      ffmpegPath ??= await resolveFfmpeg(frames.ffmpegPath);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pvd-frames-'));
      try {
        const input = path.join(dir, 'video.mp4');
        await fs.writeFile(input, await download(videoUrl));
        await runProcess(
          ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `fps=1/${frames.everySeconds},scale=512:-2`, '-frames:v', String(frames.count), '-q:v', '3', path.join(dir, 'frame_%02d.jpg')],
          30_000,
        );
        const files = (await fs.readdir(dir)).filter((name) => name.startsWith('frame_')).sort();
        return Promise.all(files.map(async (name, index) => ({ second: index * frames.everySeconds, buffer: await normalizeImage(await fs.readFile(path.join(dir, name))) })));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}
