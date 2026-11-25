import sharp from "sharp";
import { z } from "zod";
import { LIMITS } from "@/config/limits";
import { MODELS } from "@/config/models";
import { AppError } from "@/core/errors";
import { parseJson } from "@/lib/json";
import { framesEvery, peakVolume, soundTrack, withVideo } from "@/providers/ffmpeg/local";
import { shortUrl } from "@/providers/http";
import * as OpenAI from "@/providers/ai/openai";
import { sumUsage, type Result, type Usage } from "@/providers/usage";

// Watching a video ourselves, with no outside video service: the bundled ffmpeg takes timed frames and the sound
// track; OpenAI's audio model hears the sound (speech, music, effects, or nothing) and, when someone speaks, speech
// recognition gives every line with its time; one vision call then reads the frames (laid out on timed contact
// sheets) next to the timed sound and answers the caller's question. Picture and sound share one clock, so what is
// said and heard lines up with what is on screen.

/**
 * 4 frames a second, so fast cuts, text that flashes up and camera moves are all seen. Up to 240 frames: a video up
 * to a minute gets all 4 a second; a longer one gets 240 spread evenly.
 */
const MAX_FRAMES = 240;
const MIN_GAP = 0.25;
/** Frames on one contact sheet (4 across, 3 down): OpenAI sees each sheet at 1280 px, so fewer per sheet reads clearer */
const PER_SHEET = 12;
const COLS = 4;
const TILE_W = 270;
const TILE_H = 480;
/** Below this peak (dB) the sound track is silent */
const SILENT_DB = -50;
/** A stretch the speech model itself thinks is likely not speech (music misheard as words) is dropped */
const NOT_SPEECH = 0.6;

const round1 = (n: number) => Math.round(n * 10) / 10;

const heardSchema = z.object({
  kind: z.enum(["speech", "music", "speech_and_music", "effects_only", "silence"]).catch("music"),
  voice: z.string().catch(""),
  music: z.string().catch(""),
  effects: z.string().catch(""),
  timeline: z.array(z.object({ start: z.coerce.number(), end: z.coerce.number(), sound: z.string() })).catch([]),
});
type Heard = z.infer<typeof heardSchema>;

/**
 * Asks a question about a video at a public URL and returns the parsed JSON answer. `jsonSchema` is the shape the
 * answer must take; without one the prompt says what to return.
 */
export async function analyze<T = any>(videoUrl: string, prompt: string, jsonSchema?: Record<string, unknown>): Promise<Result<T>> {
  const what = `watching ${shortUrl(videoUrl)}`;
  return withVideo(videoUrl, what, async ({ file, info }) => {
    if (info.duration < 0.5) throw new AppError(`The video at ${shortUrl(videoUrl)} is too short to watch (${info.duration.toFixed(1)} seconds).`, "INVALID_INPUT", false);
    const duration = round1(info.duration);
    const usage: Usage[] = [];

    // Picture: one frame every `gap` seconds, on timed contact sheets
    const gap = Math.max(MIN_GAP, Math.ceil((duration / MAX_FRAMES) * 100) / 100);
    // Frame n is at n × gap seconds
    const frames = (await framesEvery(file, gap, MAX_FRAMES, TILE_W * 2, what)).map((jpg, i) => ({ t: Math.round(i * gap * 100) / 100, jpg }));
    const times = frames.map((f) => f.t);
    const sheets = await contactSheets(frames);

    // Sound: silence, music, speech or a mix, on the same clock as the frames
    const sound = await hear(file, info.hasAudio, duration, what, usage);

    const res = await OpenAI.structured(z.unknown(), watchPrompt(prompt, { duration, gap, sheets: sheets.length, layout: layoutText(times), sound, jsonSchema }), { images: sheets, model: MODELS.vision });
    usage.push(res.usage);
    const total = sumUsage(usage);
    return { data: res.data as T, usage: { provider: "openai", ...total, model: MODELS.vision } };
  });
}

/** The sound track in words: what kind of sound it is, what is heard when, and every spoken line with its time. */
async function hear(file: string, hasAudio: boolean, duration: number, what: string, usage: Usage[]): Promise<string> {
  if (!hasAudio) return "The video has no sound track.";
  if ((await peakVolume(file, what)) < SILENT_DB) return "The sound track is silent.";
  const seconds = Math.min(duration, LIMITS.watchSoundMaxSec);
  const mp3 = await soundTrack(file, "speech", seconds, what);

  const listened = await OpenAI.listen(mp3, listenPrompt(seconds));
  usage.push(listened.usage);
  const heard = parseHeard(listened.data);

  // Speech recognition only when someone speaks: on music alone it writes words nobody said
  let lines: OpenAI.SpeechSegment[] = [];
  if (heard.kind === "speech" || heard.kind === "speech_and_music") {
    const res = await OpenAI.transcribe(mp3, seconds, what);
    usage.push(res.usage);
    lines = res.data.filter((s) => s.noSpeech < NOT_SPEECH);
  }
  return soundText(heard, lines, seconds < duration ? seconds : null);
}

function parseHeard(raw: string): Heard {
  try {
    return heardSchema.parse(parseJson(raw));
  } catch {
    // An answer in plain words still says what is heard
    return { kind: /speak|voice|says|talk/i.test(raw) ? "speech_and_music" : "music", voice: "", music: "", effects: "", timeline: [{ start: 0, end: 0, sound: raw.slice(0, 1500) }] };
  }
}

const KIND: Record<Heard["kind"], string> = {
  speech: "speech only, no music",
  music: "music only, nobody speaks",
  speech_and_music: "speech over music",
  effects_only: "sound effects or natural sound only, no speech or music",
  silence: "silent",
};

function soundText(heard: Heard, lines: OpenAI.SpeechSegment[], cutAt: number | null): string {
  const out = [`What it is: ${KIND[heard.kind]}.`];
  if (heard.voice) out.push(`Voice: ${heard.voice}`);
  if (heard.music) out.push(`Music: ${heard.music}`);
  if (heard.effects) out.push(`Effects: ${heard.effects}`);
  if (heard.timeline.length) {
    out.push("Heard over time:", ...heard.timeline.map((s) => (s.end > s.start ? `- ${round1(s.start)}–${round1(s.end)} s: ${s.sound}` : `- ${s.sound}`)));
  }
  if (lines.length) out.push("Spoken words, timed (speech recognition: exact words; match them to the frames by time):", ...lines.map((l) => `- ${round1(l.start)}–${round1(l.end)} s: "${l.text}"`));
  else if (heard.kind === "speech" || heard.kind === "speech_and_music") out.push("Spoken words: none could be made out.");
  if (cutAt) out.push(`(Only the first ${cutAt} seconds of sound were listened to.)`);
  return out.join("\n");
}

function listenPrompt(seconds: number): string {
  return `Listen to this ${seconds}-second sound track from a short social media video. Times are in seconds from the start.

Say what kind of sound it is: speech only, music only, speech over music, sound effects or natural sound only, or silence. Many of these videos are music only: then say nobody speaks, and don't take sung lyrics for speech (describe them under music).

Return JSON only:
{
  "kind": "speech" | "music" | "speech_and_music" | "effects_only" | "silence",
  "voice": "who speaks (man, woman, child, several), how they sound (tone, energy, accent, language), and whether it sounds like someone talking to camera or a voice-over; \\"\\" when nobody speaks",
  "music": "genre, mood, tempo in beats per minute, instruments, sung or instrumental, and where it builds, drops or changes; \\"\\" when there is none",
  "effects": "the sound effects (whooshes, hits, clicks, risers) or natural sound and when they come; \\"\\" when there are none",
  "timeline": [{ "start": number, "end": number, "sound": "what is heard in this stretch" }]
}
The timeline covers the whole track in order, a new entry wherever the sound changes (music starts or drops, a voice comes in, an effect hits).`;
}

/** Each frame's time by its place on the sheets, so timing never depends on the drawn labels */
function layoutText(times: number[]): string {
  const rows: string[] = [];
  for (let s = 0; s * PER_SHEET < times.length; s++) {
    const sheet = times.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    for (let r = 0; r * COLS < sheet.length; r++) rows.push(`Sheet ${s + 1}, row ${r + 1}: ${sheet.slice(r * COLS, (r + 1) * COLS).map((t) => `${t.toFixed(2)} s`).join(", ")}`);
  }
  return rows.join("\n");
}

function watchPrompt(question: string, v: { duration: number; gap: number; sheets: number; layout: string; sound: string; jsonSchema?: Record<string, unknown> }): string {
  return `You are given a ${v.duration}-second video as its picture and its sound, on one clock (seconds from the start):
- PICTURE: the ${v.sheets} attached contact sheet${v.sheets === 1 ? "" : "s"} show one frame every ${v.gap} seconds, in order (left to right, top to bottom, sheet after sheet), each frame labelled with its time. Judge cuts, camera moves and pacing from the change between frames.
- SOUND: below. Match it to the picture by time: words said at 3.2 s go with the frame shown nearest 3.2 s.

FRAME TIMES (left to right in each row)
${v.layout}

SOUND
${v.sound}

Treat this as watching the video itself, picture and sound together.

${question}

${v.jsonSchema ? `Answer with JSON only, in exactly this shape (JSON Schema):\n${JSON.stringify(v.jsonSchema)}` : "Answer with JSON only, as asked above."}`;
}

/** Frames laid out 4 across with their times, 12 to a sheet, as inline JPEGs, so one call sees the whole video in order. */
async function contactSheets(frames: { t: number; jpg: Buffer }[]): Promise<string[]> {
  const sheets: string[] = [];
  for (let s = 0; s * PER_SHEET < frames.length; s++) {
    const part = frames.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const tiles = await Promise.all(
      part.map(async (f, i) => {
        const label = Buffer.from(`<svg width="${TILE_W}" height="34"><rect width="${TILE_W}" height="34" fill="black" opacity="0.75"/><text x="8" y="24" font-size="22" font-family="Arial" fill="white">${f.t.toFixed(2)}s</text></svg>`);
        const input = await sharp(f.jpg)
          .resize(TILE_W, TILE_H, { fit: "contain", background: "#000000" })
          .composite([{ input: label, top: 0, left: 0 }])
          .toBuffer();
        return { input, left: (i % COLS) * TILE_W, top: Math.floor(i / COLS) * TILE_H };
      })
    );
    const jpg = await sharp({ create: { width: TILE_W * COLS, height: TILE_H * Math.ceil(part.length / COLS), channels: 3, background: "#000000" } })
      .composite(tiles)
      .jpeg({ quality: 80 })
      .toBuffer();
    sheets.push(`data:image/jpeg;base64,${jpg.toString("base64")}`);
  }
  return sheets;
}
