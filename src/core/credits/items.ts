import type { Format } from "@/core/creative/brief";
import type { CreditAction } from "@/config/credits";

// What making one post costs: the action is picked from the slot's format and what it copies.

export interface ItemForCredits {
  format: Format;
  angle?: string | null;
  reference_image_key?: string | null;
  reference_video_id?: string | null;
  /** Videos made by hand: 720p has its own price */
  video_resolution?: string | null;
}

export function itemAction(item: ItemForCredits): CreditAction {
  if (item.format === "video") {
    const hd = item.video_resolution === "720p";
    if (item.reference_video_id) return hd ? "video_copy_720p" : "video_copy";
    return hd ? "video_720p" : "video";
  }
  if (item.format === "carousel") return "carousel";
  if (item.format === "text") return "text_post";
  return item.reference_image_key ? "image_ad_reference" : "image_ad";
}

const NAMES: Record<Format, string> = { static: "Image ad", carousel: "Carousel", video: "Video", text: "Text post" };

/** "Video · Summer sale" (Copy a video says so) */
export function itemLabel(item: ItemForCredits): string {
  const base = item.format === "video" && item.reference_video_id ? "Copy a video" : NAMES[item.format];
  const name = item.format === "video" && item.video_resolution === "720p" ? `${base} (720p)` : base;
  const angle = item.angle?.trim();
  return angle ? `${name} · ${angle.length > 80 ? `${angle.slice(0, 79)}…` : angle}` : name;
}

/** "This video", for the not-enough-credits message */
export function itemWhat(format: Format): string {
  return format === "static" ? "This image ad" : format === "carousel" ? "This carousel" : format === "video" ? "This video" : "This text post";
}
