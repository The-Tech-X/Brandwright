import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "@/agents/weekly/task";
import type { VideoSound } from "@/core/content/styles";
import { AppError } from "@/core/errors";
import { ai } from "@/providers/ai/registry";
import { publicUrl } from "@/providers/storage/paths";
import { REFERENCE_VIDEO_JSON_SCHEMA, referenceVideoPrompt, referenceVideoSchema, type ReferenceVideo } from "@/prompts/agents/reference-video";

// A reference video the owner gave for one post ("make this video for my product"), read once and kept on its
// reference_videos row, so "Make again" reuses it and the breakdown stays after the file is gone (storage deletes
// it after 7 days). It is watched like every video (ai.analyzeVideo): timed frames and the timed sound (speech,
// music or both) read together, so every scene comes with its words on screen and the words said in it.

/** The saved breakdown of a reference video, or null when it hasn't been read yet. */
export async function loadReference(db: SupabaseClient, assetId: string): Promise<ReferenceVideo | null> {
  const { data, error } = await db.from("reference_videos").select("analysis").eq("id", assetId).maybeSingle();
  if (error) throw error;
  const parsed = referenceVideoSchema.safeParse(data?.analysis);
  return parsed.success && parsed.data.scenes.length ? parsed.data : null;
}

/** Reads the reference video (once) before the prompt is written. */
export async function studyReference(task: Task, db: () => SupabaseClient, assetId: string): Promise<void> {
  await task(
    "study-reference",
    async (track) => {
      const known = await loadReference(db(), assetId);
      if (known) return { known: true, breakdown: known };
      const { data, error } = await db().from("reference_videos").select("storage_key").eq("id", assetId).single();
      if (error) throw error;
      if (!data.storage_key) throw new AppError("The reference video's file is gone. Add the video again.", "INVALID_INPUT", false);
      const res = await ai.analyzeVideo(publicUrl(data.storage_key), referenceVideoPrompt(), REFERENCE_VIDEO_JSON_SCHEMA);
      track(res.usage);
      const breakdown = referenceVideoSchema.parse(res.data);
      if (!breakdown.scenes.length) throw new AppError("The reference video couldn't be split into scenes. Try another video.", "INVALID_INPUT", false);
      const { error: saveError } = await db()
        .from("reference_videos")
        .update({ analysis: breakdown, summary: breakdown.summary || null, duration_sec: breakdown.duration || null, analyzed_at: new Date().toISOString() })
        .eq("id", assetId);
      if (saveError) throw saveError;
      return { known: false, breakdown };
    },
    (r) =>
      r.known
        ? "The reference video was already read"
        : `Watched the reference video: ${Math.round(r.breakdown.duration)} seconds, ${r.breakdown.scenes.length} scenes, ${r.breakdown.speech.length} spoken lines`
  );
}

const said = (s: string) => !!s.trim() && !/^(none|no\b|nobody|n\/a|-)/i.test(s.trim());

/** How the video sounds when it follows a reference: the reference's own voice and music. */
export function referenceSound(r: ReferenceVideo, talkingFootage: boolean): VideoSound {
  if (!said(r.sound.voice)) return "music";
  if (talkingFootage && /camera|on screen|on-screen/i.test(r.sound.voice)) return "speech";
  return said(r.sound.music) ? "voice_music" : "voice";
}
