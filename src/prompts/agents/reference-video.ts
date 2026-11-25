import { z } from "zod";

// A video the owner wants made again for their own product, broken down the way an editor would:
// every scene with its times, what it shows and how it is filmed, the words on screen and the words
// said, the cut to the next scene, and the sound, pacing and look of the whole. It is watched once
// (ai.analyzeVideo: timed frames and timed sound together); the video writer then makes it with this business's product.

const seconds = z.coerce.number().min(0).max(3600);
const text = (max: number) => z.string().trim().max(max).catch("");

const sceneSchema = z.object({
  start: seconds,
  end: seconds,
  shows: text(300),
  shot: text(80),
  camera: text(160),
  people: text(160),
  action: text(240),
  onScreenText: text(200),
  textPosition: text(60),
  textStyle: text(160),
  spoken: text(400),
  transition: text(100),
  purpose: text(100),
});
export type ReferenceScene = z.infer<typeof sceneSchema>;

export const referenceVideoSchema = z.object({
  duration: seconds,
  summary: text(600),
  format: text(240),
  pacing: text(300),
  look: text(300),
  sound: z.object({ voice: text(240), music: text(240), effects: text(240) }).catch({ voice: "", music: "", effects: "" }),
  captions: text(240),
  ending: text(240),
  /** Every spoken line with its time and who says it (from the timed speech recognition) */
  speech: z.array(z.object({ start: seconds, end: seconds, speaker: text(120), text: text(400) })).catch([]),
  scenes: z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list
        .flatMap((s) => {
          const parsed = sceneSchema.safeParse(s);
          return parsed.success && parsed.data.end > parsed.data.start ? [parsed.data] : [];
        })
        .sort((a, b) => a.start - b.start)
        .slice(0, 40)
    ),
});
export type ReferenceVideo = z.infer<typeof referenceVideoSchema>;

const STR = { type: "string" };

/** JSON schema the video watcher answers in. */
export const REFERENCE_VIDEO_JSON_SCHEMA = {
  type: "object",
  properties: {
    duration: { type: "number" },
    summary: STR,
    format: STR,
    pacing: STR,
    look: STR,
    sound: { type: "object", properties: { voice: STR, music: STR, effects: STR }, required: ["voice", "music", "effects"] },
    captions: STR,
    ending: STR,
    speech: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" }, speaker: STR, text: STR }, required: ["start", "end", "speaker", "text"] } },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          shows: STR,
          shot: STR,
          camera: STR,
          people: STR,
          action: STR,
          onScreenText: STR,
          textPosition: STR,
          textStyle: STR,
          spoken: STR,
          transition: STR,
          purpose: STR,
        },
        required: ["start", "end", "shows", "shot", "camera", "people", "action", "onScreenText", "textPosition", "textStyle", "spoken", "transition", "purpose"],
      },
    },
  },
  required: ["duration", "summary", "format", "pacing", "look", "sound", "captions", "ending", "speech", "scenes"],
};

export function referenceVideoPrompt(): string {
  return `You are breaking down a short social media video for an editor who will remake it, scene by scene, for a different business and its product. Watch all of it, picture and sound.

Return:
- duration: its length in seconds.
- summary: what the video is and how it works, in two or three sentences.
- format: what kind of video it is and how it is made.
- pacing: how fast it cuts, and how that changes through the video.
- look: colour, light, filming style and editing style.
- sound: voice (who speaks, on camera or as a voice-over, and how they sound; "none" when nobody speaks), music (its mood, tempo in beats per minute, instruments, where it builds, drops or changes, and whether the cuts follow the beat; "none" when there is none), effects (the sound effects and where they come; "none" when there are none).
- captions: whether the spoken words are shown on screen, how they look and where they sit; "none" when they aren't.
- ending: how it ends (the last picture, a call to action, a logo or an end card).
- speech: every spoken line in order, with start and end (seconds), speaker (who says it, and whether they speak on camera with their lips moving or as a voice-over) and text (the exact words); an empty list when nobody speaks.
- scenes: every scene in order, one per cut, with no gaps, from the first frame to the last:
  start and end (seconds), shows (what is in the picture), shot (how close the camera is), camera (how it moves), people (who is in it and how they look, or "none"), action (what happens), onScreenText (the exact words shown, or ""), textPosition (where they sit on screen, or ""), textStyle (how they look and appear, or ""), spoken (the words said in this scene, or ""), transition (how it cuts to the next scene), purpose (what the scene does for the video).`;
}
