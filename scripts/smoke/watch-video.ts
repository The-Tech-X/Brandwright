import { ai } from "@/providers/ai/registry";
import { smoke } from "./_run";

// Paid (OpenAI: vision, audio and speech): the bundled ffmpeg cuts frames and sound from a public video, then one
// question is answered from both. Usage: npm run smoke scripts/smoke/watch-video.ts <public video URL>
const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run smoke scripts/smoke/watch-video.ts <public video URL>");
  process.exit(1);
}

await smoke("watch a video", async () => {
  const r = await ai.analyzeVideo<{ summary: string; sound: string; spoken: string[] }>(
    url,
    'Say what the video shows and how it sounds. Return JSON: { "summary": string, "sound": "speech, music, both or none, and what is heard", "spoken": ["each spoken line with its time"] }'
  );
  return { result: r.data, usage: r.usage };
});
