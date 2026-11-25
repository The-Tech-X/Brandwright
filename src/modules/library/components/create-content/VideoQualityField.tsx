"use client";

import { ChoiceCards } from "@/components/kit/choices";
import { Field } from "@/components/kit/Field";
import { formatCredits } from "@/config/credits";
import { DIRECT_VIDEO, VIDEO_RESOLUTIONS, type VideoResolution } from "@/config/video-direct";
import { itemAction } from "@/core/credits/items";
import { useCreditPrices } from "@/modules/insights/hooks/useInsights";

const SAY: Record<VideoResolution, string> = { "480p": "Standard", "720p": "Sharper, HD" };

export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = DIRECT_VIDEO.resolution;

/** 480p or 720p for a video made by hand, each with its live credit price (720p costs more). */
export function VideoQualityField({ value, onChange, copying = false }: { value: VideoResolution; onChange: (v: VideoResolution) => void; copying?: boolean }) {
  const { data: prices } = useCreditPrices();
  const options = VIDEO_RESOLUTIONS.map((r) => {
    const credits = prices?.find((p) => p.action === itemAction({ format: "video", reference_video_id: copying ? "copy" : null, video_resolution: r }))?.credits;
    return { value: r, label: r, description: credits === undefined ? SAY[r] : `${SAY[r]} · ${formatCredits(credits)} credits` };
  });
  return (
    <Field label="Quality" hint="720p looks sharper and costs more credits.">
      <ChoiceCards options={options} value={value} onChange={onChange} label="Quality" />
    </Field>
  );
}
