import { inngest } from "./client";
import { adoptFinishedMedia } from "@/core/plans/plans";
import { failureMessage, toInngestError } from "./to-inngest-error";
import { businessDb } from "@/lib/supabase/business";
import { refundCredits } from "@/core/credits/ledger";
import { getMedia, markReady, markFailed, productNameFor, type Media } from "@/core/media";
import { getProfile } from "@/core/profile";
import { AppError } from "@/core/errors";
import { parseJson } from "@/lib/json";
import { buildVideoScriptPrompt, sceneCountForDuration } from "@/prompts/video-script";
import { buildScenesPrompt } from "@/prompts/video-scenes";
import { withVideoReferenceInstruction } from "@/prompts/image";
import { ai } from "@/providers/ai/registry";
import { assertVideoReady, getJob, submitRender } from "@/providers/ffmpeg/client";
import { CANVAS, type CanvasRatio } from "@/creative/sizes";
import { loadTheme } from "@/creative/theme";
import { buildTimeline, type BuildScene } from "@/creative/video/timeline";
import { linkText, timelineTheme, videoCanvas } from "@/creative/video/parts";
import { choosePreset } from "@/creative/video/preset";
import { sfxUrls } from "@/config/sfx";
import { MODELS } from "@/config/models";
import { SCENE_LAYOUT_SYSTEM, sceneLayoutPrompt, sceneLayoutSchema } from "@/prompts/agents/scene-layout";
import { copyToStorage } from "@/agents/producer/media";
import { mediaKey, publicUrl, ratioName, workKey } from "@/providers/storage/paths";
import { NonRetriableError } from "inngest";

const MAX_IMAGE_POLLS = 12; // ~4.5 min
const MAX_VIDEO_POLLS = 25; // ~12.5 min
const MAX_RENDER_POLLS = 30; // ~10 min

const CLIP_STYLE =
  "Cinematic quality, natural color grade, shallow depth of field, smooth slow camera movement only, no cuts within clip, photorealistic, preserve the exact scene composition from the image. The subject does not talk or speak — no lip movement, mouth stays naturally closed or neutral throughout; narration is a separate voiceover added afterward, not something happening on screen.";

interface SceneImage {
  taskId: string;
  url: string | null;
  scene: number;
  prompt: string;
  videoScenario: string;
  retried: boolean;
}

interface SceneClip {
  taskId: string;
  url: string | null;
  scene: number;
  prompt: string;
  imageUrl: string;
  kieDuration: number;
  targetDuration: number;
  retried: boolean;
}

export const generateVideo = inngest.createFunction(
  {
    id: "generate-video",
    retries: 3,
    concurrency: [{ limit: 2, key: "event.data.businessId" }],
    cancelOn: [{ event: "media/deleted", if: "event.data.mediaId == async.data.mediaId && event.data.businessId == async.data.businessId" }],
    onFailure: async ({ event }) => {
      const { businessId } = event.data.event.data;
      const db = businessDb(businessId);
      const msg = failureMessage(event.data.error);
      // Nothing was made: its credits go back
      if (event.data.event.data.creditKey) await refundCredits(businessId, event.data.event.data.creditKey);
      await markFailed(db, event.data.event.data.mediaId, msg);
    },
  },
  { event: "media/generate-video" },
  async ({ event, step }) => {
    const { businessId } = event.data;
    const db = businessDb(businessId);
    // Every step turns AppErrors into retry / stop for Inngest
    const run = <T>(id: string, fn: () => Promise<T>) => step.run(id, () => fn().catch(toInngestError));

    // Before anything is paid for: the video renderer must be connected
    await run("check-video-setup", () => assertVideoReady());

    const media = await step.run("load-media", () => getMedia(db, event.data.mediaId));
    if (!media.idea) throw new NonRetriableError("No idea provided");

    const profile = await step.run("load-profile", () => getProfile(db));
    const productName = await step.run("load-product", () => productNameFor(db, media as Media));

    const durationSec = media.duration_sec || 15;
    const sceneCount = sceneCountForDuration(durationSec);
    const referenceUrl = media.reference_image_key
      ? publicUrl(media.reference_image_key)
      : undefined;
    // The size picked in Create content; scenes are shot portrait, square or landscape and cropped to fit
    const canvas = CANVAS[(media.aspect_ratio as CanvasRatio) ?? "9:16"] ?? CANVAS["9:16"];
    const shotRatio = canvas.ratio === "16:9" ? "16:9" : canvas.ratio === "1:1" ? "1:1" : "9:16";

    // 1. Script, one line per scene
    const script = await run("write-script", async () => {
      const prompt = buildVideoScriptPrompt(media.idea!, profile, {
        durationSec,
        character: media.character || undefined,
        language: media.language || undefined,
        product: productName || undefined,
      });
      const lines = parseJson<{ script: string[] }>((await ai.text(prompt)).data).script;
      if (!Array.isArray(lines) || !lines.length) throw new AppError("Couldn't write the script. Try again.", "UNKNOWN", true);
      return lines.slice(0, sceneCount);
    });

    // 2. One visual prompt per line
    const scenes = await run("plan-scenes", async () => {
      const prompt = buildScenesPrompt(script, profile, { character: media.character || undefined });
      return parseJson<{ visual_prompts: { scene: number; prompt: string; video_scenario: string }[] }>((await ai.text(prompt)).data)
        .visual_prompts;
    });

    // 3. No recorded voice-over (no voice service): each scene keeps its planned length
    const voices = null as { key: string; durationSec: number; words: { word: string; start: number; end: number }[] }[] | null;

    // 4. Scene images
    const images: SceneImage[] = await run("create-images", async () => {
      const list: SceneImage[] = [];
      for (const s of scenes) {
        const prompt = referenceUrl ? withVideoReferenceInstruction(s.prompt) : s.prompt;
        const { data: taskId } = await ai.image.create(prompt, shotRatio, referenceUrl ? [referenceUrl] : []);
        list.push({ taskId, url: null, scene: s.scene, prompt: s.prompt, videoScenario: s.video_scenario, retried: false });
      }
      return list;
    });

    let imagesDone = false;
    for (let i = 0; i < MAX_IMAGE_POLLS && !imagesDone; i++) {
      await step.sleep(`wait-images-${i}`, i === 0 ? "30s" : "20s");
      const polled = await run(`poll-images-${i}`, async () => {
        for (const img of images) {
          if (img.url) continue;
          const status = await ai.image.status(img.taskId);
          if (status.state === "success") img.url = ai.task.resultUrl(status);
          if (status.state !== "fail") continue;
          // One retry without the reference image, then give up
          if (img.retried) throw ai.task.error(status, `scene ${img.scene} image`);
          img.taskId = (await ai.image.create(img.prompt, shotRatio)).data;
          img.retried = true;
        }
        return images;
      });
      images.splice(0, images.length, ...polled);
      imagesDone = images.every((img) => img.url);
    }
    if (!imagesDone) throw new NonRetriableError("Making the scene images took too long. Try again.");

    // 5. Scene clips from the images
    const clips: SceneClip[] = await run("create-clips", async () => {
      const list: SceneClip[] = [];
      for (const img of images) {
        const voice = voices?.[img.scene - 1];
        // +0.5s so the stitch never cuts the last word
        const targetDuration = voice ? voice.durationSec + 0.5 : 4;
        // Seedance makes 4–15s; the stitch freezes the last frame for any extra
        const kieDuration = Math.min(15, Math.max(4, Math.ceil(targetDuration)));
        const prompt = `${img.videoScenario} ${CLIP_STYLE}`;
        const { data: taskId } = await ai.video.create(prompt, img.url!, shotRatio, kieDuration);
        list.push({ taskId, url: null, scene: img.scene, prompt, imageUrl: img.url!, kieDuration, targetDuration, retried: false });
      }
      return list;
    });

    let clipsDone = false;
    for (let i = 0; i < MAX_VIDEO_POLLS && !clipsDone; i++) {
      await step.sleep(`wait-clips-${i}`, i === 0 ? "40s" : "30s");
      const polled = await run(`poll-clips-${i}`, async () => {
        for (const clip of clips) {
          if (clip.url) continue;
          const status = await ai.video.status(clip.taskId);
          if (status.state === "success") clip.url = ai.task.resultUrl(status);
          if (status.state !== "fail") continue;
          if (clip.retried) throw ai.task.error(status, `scene ${clip.scene} clip`);
          clip.taskId = (await ai.video.create(clip.prompt, clip.imageUrl, shotRatio, clip.kieDuration)).data;
          clip.retried = true;
        }
        return clips;
      });
      clips.splice(0, clips.length, ...polled);
      clipsDone = clips.every((c) => c.url);
    }
    if (!clipsDone) throw new NonRetriableError("Making the scene clips took too long. Try again.");

    // 6. Our renderer draws the video (the same one as the agents' videos): clips copied into our
    // storage, the brand's look, the closing card
    const outputKey = mediaKey(businessId, media.id, `${ratioName(media.aspect_ratio || "9:16")}.mp4`);
    const parts = await run("video-parts", async () => {
      const kept: { clip: string; still: string }[] = [];
      for (const c of clips) {
        const clip = workKey(businessId, media.id, `scene-${c.scene}.mp4`);
        const still = workKey(businessId, media.id, `scene-${c.scene}.png`);
        await copyToStorage(c.url!, clip);
        await copyToStorage(c.imageUrl, still);
        kept.push({ clip, still });
      }
      // No music service: the video keeps the sound effects only
      const musicKey: string | null = null;
      // Where the subject is in each scene, so captions sit beside it
      const look = await ai
        .structured(sceneLayoutSchema, sceneLayoutPrompt(kept.length), { system: SCENE_LAYOUT_SYSTEM, images: kept.map((k) => publicUrl(k.still)), model: MODELS.vision })
        .then((r) => r.data.scenes)
        .catch(() => []);
      return { kept, musicKey, look };
    });

    const renderId = await run("render", async () => {
      // The ad's own "use logo" box decides here
      const theme = await loadTheme(db, { showLogo: media.use_logo !== false });
      const { data: profile } = await db.from("business_profile").select("tone, industry, website").single();
      const preset = choosePreset(profile?.tone ?? {}, profile?.industry ?? null, "faceless");
      // The product's name and any numbers stand out in the captions
      const keywords = [...(productName ?? "").split(/\s+/), ...script.join(" ").split(/\s+/).filter((w) => /\d/.test(w))].filter((w) => w.length > 1);
      const scenes: BuildScene[] = clips.map((c, i) => {
        const look = parts.look.find((l) => l?.image === i + 1);
        const voice = voices?.[c.scene - 1];
        return {
          kind: i === 0 ? "hook" : "benefit",
          media: { kind: "video", url: publicUrl(parts.kept[i].clip), trimStartSec: 0, trimEndSec: c.kieDuration, volume: 0, playbackRate: 1 },
          reveal: null,
          layout: look ? { subject: look.subject, zone: look.textZone, light: look.light } : { subject: null, zone: null, light: null },
          voice: voice ? { url: publicUrl(voice.key), durationSec: voice.durationSec, words: voice.words } : null,
          speech: null,
          seconds: voice ? null : c.targetDuration,
          overlay: "",
          keywords,
          sticker: null,
          stat: null,
          review: null,
          price: null,
          offer: null,
          transition: "smooth",
        };
      });
      // The closing card on the first scene's picture
      scenes.push({ ...scenes[0], kind: "cta", voice: null, seconds: 2.5, keywords: [], media: { kind: "image", url: publicUrl(parts.kept[0].still), motion: { fromScale: 1, toScale: 1, fromX: 0, toX: 0, fromY: 0, toY: 0 } } });
      const timeline = buildTimeline({
        canvas: videoCanvas(canvas.ratio),
        preset,
        theme: timelineTheme(theme),
        scenes,
        hook: "",
        cta: { label: "Learn more", line: "", link: linkText(profile?.website) },
        music: parts.musicKey ? { url: publicUrl(parts.musicKey) } : null,
        sfx: sfxUrls(),
        progressBar: false,
      });
      return submitRender("ad", timeline as unknown as Record<string, unknown>, outputKey);
    });

    let rendered = false;
    for (let i = 0; i < MAX_RENDER_POLLS && !rendered; i++) {
      await step.sleep(`wait-render-${i}`, "20s");
      rendered = await run(`poll-render-${i}`, async () => {
        const job = await getJob(renderId);
        if (job.status === "failed") {
          throw new AppError(`The video couldn't be put together: "${job.error ?? "unknown"}". Try again.`, "UNKNOWN", false);
        }
        return job.status === "done";
      });
    }
    if (!rendered) throw new NonRetriableError("Putting the video together took too long. Try again.");

    await step.run("finalize", async () => {
      await markReady(db, media.id, outputKey);
      // A planned post's media made here: the post picks it up (as needing a look)
      await adoptFinishedMedia(db, media.id);
    });
    return { success: true, mediaId: media.id };
  }
);
