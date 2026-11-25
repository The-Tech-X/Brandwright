import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpegPath from "ffmpeg-static";
import { LIMITS } from "@/config/limits";
import { AppError } from "@/core/errors";
import { cleanReason } from "@/core/error-text";
import { request, shortUrl, statusError } from "@/providers/http";

// ffmpeg bundled with the app (the ffmpeg-static package), run inside our own server or job: no worker, no
// outside service. Used to read videos (frames and the sound track) and to cut a reference video's music.
// Files live in the function's temp folder only while one job uses them.

const SERVICE = "ffmpeg";

/** What ffmpeg reads from a video file's header */
export interface VideoInfo {
  duration: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

export interface LocalVideo {
  file: string;
  info: VideoInfo;
}

/** Runs ffmpeg and returns what it wrote to stdout (the picture or sound) and its log. */
function run(args: string[], what: string, opts: { okExit?: boolean; timeoutMs?: number } = {}): Promise<{ out: Buffer; log: string }> {
  if (!ffmpegPath) throw new AppError(`${SERVICE} (${what}) isn't installed on this server: the ffmpeg-static package has no binary for it.`, "NOT_CONFIGURED", false);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath as string, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let log = "";
    child.stdout.on("data", (b: Buffer) => out.push(b));
    // Only the end of the log matters for errors; keep it from growing on long jobs
    child.stderr.on("data", (b: Buffer) => (log = (log + b.toString()).slice(-20_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? LIMITS.downloadTimeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AppError(`${SERVICE} (${what}) couldn't start: ${cleanReason(err.message, 160)}.`, "NOT_CONFIGURED", false));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") return reject(new AppError(`${SERVICE} (${what}) took too long and was stopped.`, "TIMEOUT", true));
      if (code !== 0 && !opts.okExit) {
        const last = log.trim().split("\n").filter(Boolean).slice(-2).join(" ");
        return reject(new AppError(`${SERVICE} (${what}) couldn't read the video: "${cleanReason(last, 240)}".`, "INVALID_INPUT", false));
      }
      resolve({ out: Buffer.concat(out), log });
    });
  });
}

/** Length, size and whether there is a sound track, from ffmpeg's own description of the file. */
async function probe(file: string, what: string): Promise<VideoInfo> {
  // With no output ffmpeg describes the input and exits 1: that's expected here
  const { log } = await run(["-i", file], what, { okExit: true, timeoutMs: 30_000 });
  const d = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!d) throw new AppError(`${SERVICE} (${what}) found no video in the file: "${cleanReason(log.trim().split("\n").slice(-1)[0] ?? "", 200)}".`, "INVALID_INPUT", false);
  const size = log.match(/Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    hasAudio: /Stream #[^\n]*Audio:/.test(log),
  };
}

/**
 * Downloads a video into a temp folder, describes it, hands it to `work`, then deletes the folder.
 * Streamed to disk, so a large video never sits in memory.
 */
export async function withVideo<T>(url: string, what: string, work: (video: LocalVideo) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "bw-video-"));
  try {
    const res = await request("The video host", url, {}, LIMITS.downloadTimeoutMs);
    if (!res.ok || !res.body) throw statusError("The video host", res.status, undefined, undefined, `downloading ${shortUrl(url)} to watch it`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > LIMITS.watchVideoMaxBytes) {
      throw new AppError(`The video at ${shortUrl(url)} is ${Math.round(declared / 1048576)} MB; videos up to ${Math.round(LIMITS.watchVideoMaxBytes / 1048576)} MB can be watched.`, "INVALID_INPUT", false);
    }
    const file = path.join(dir, "video");
    let seen = 0;
    const counted = Readable.fromWeb(res.body as WebReadableStream).on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > LIMITS.watchVideoMaxBytes) counted.destroy(new AppError(`The video at ${shortUrl(url)} is over ${Math.round(LIMITS.watchVideoMaxBytes / 1048576)} MB, the most that can be watched.`, "INVALID_INPUT", false));
    });
    await pipeline(counted, createWriteStream(file));
    return await work({ file, info: await probe(file, what) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A frame every `gap` seconds from the start (frame n is at n × gap), `max` at most, as JPEGs `width` pixels wide.
 * One pass over the video: seeking per frame decodes from the last keyframe every time and is many times slower.
 */
export async function framesEvery(file: string, gap: number, max: number, width: number, what: string): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(path.dirname(file), "frames-"));
  try {
    await run(["-i", file, "-an", "-vf", `fps=1/${gap},scale=${width}:-2`, "-frames:v", String(max), "-q:v", "4", path.join(dir, "f-%04d.jpg")], what);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".jpg")).sort();
    if (!names.length) throw new AppError(`${SERVICE} (${what}) found no pictures in the video.`, "INVALID_INPUT", false);
    return Promise.all(names.map((n) => readFile(path.join(dir, n))));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The sound track: `speech` is small mono MP3 for listening and transcribing; `music` is stereo WAV at full quality
 * (a reference video's music for the video model).
 */
export async function soundTrack(file: string, kind: "speech" | "music", maxSec: number, what: string): Promise<Buffer> {
  const format =
    kind === "speech"
      ? ["-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3"]
      : ["-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav"];
  const { out } = await run(["-i", file, "-vn", "-t", String(maxSec), ...format, "pipe:1"], what);
  return out;
}

/** The loudest moment of the sound track in dB (0 is the loudest possible; below about -50 is silence). */
export async function peakVolume(file: string, what: string): Promise<number> {
  const { log } = await run(["-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], what, { timeoutMs: 120_000 });
  const peak = log.match(/max_volume:\s*(-?[\d.]+|-inf) dB/)?.[1];
  return peak === undefined || peak === "-inf" ? -Infinity : Number(peak);
}
