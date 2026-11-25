import { NonRetriableError } from "inngest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { directBrief, directContext, directPhotos, directPrompt, type DirectImage } from "@/agents/creative-director/direct-context";
import { loadCreativeContext } from "@/agents/creative-director/context";
import { canvasesFor, kieRatio } from "@/agents/producer/canvases";
import { gpt2Resolution, imageEngine, openaiFallbackSize, openaiImage, openaiImageSize } from "@/config/image-ads";
import { ai } from "@/providers/ai/registry";
import { startJob, waitForJobs, type KieJob } from "@/agents/producer/kie";
import { keepPhoto, markMediaReady, saveFile, startMedia, syncCost } from "@/agents/producer/media";
import type { Step } from "@/agents/producer/types";
import { loadTheme } from "@/creative/theme";
import { getItem, updateItem } from "@/core/plans/plans";
import type { PlanItem } from "@/core/plans/types";
import { request } from "@/providers/http";
import { finalName, mediaKey, publicUrl, ratioName, workKey } from "@/providers/storage/paths";
import { upload } from "@/providers/storage/r2";
import { logUsage, taskFor } from "./task";
import { PASS_SCORE } from "@/agents/qa-critic/gate1";
import { MODELS } from "@/config/models";
import { AppError } from "@/core/errors";
import type { QaCheck, QaReport } from "@/core/plans/types";
import { DIRECT_IMAGE_QA_SYSTEM, directImageReviewSchema } from "@/prompts/agents/qa-asset";

// Direct image ad (the mode in config/image-ads.ts): "give the image model everything". No Creative Director
// and no logo drawn by code. All the context the Creative Director would read goes to the image model as plain
// text with a short creative brief (concept, golden-ratio composition, the words, the logo), with the product
// photos and the logo attached. The QA Critic then checks the finished ad with OpenAI vision; below the bar it is
// made once more with the critic's fix. Its picture is the final ad (only resized to each platform's size).

/** Photos sent with the request, besides the logo */
const MAX_PHOTOS = 4;

export async function produceDirect(
  step: Step,
  db: () => SupabaseClient,
  scope: { businessId: string; planId: string; itemId: string; oneOff: boolean },
  settle: (status: "ready" | "needs_review", report?: Partial<QaReport>) => Promise<unknown>
): Promise<{ status: "ready" | "needs_review" }> {
  const { businessId, planId, itemId, oneOff } = scope;
  const cd = taskFor(step, "creative_director", { businessId, planId, itemId });

  // 1. Gather the context (no AI writes anything), make the post's brief by code, save it
  const prepared = await cd(
    "direct-context",
    async (track) => {
      const { ctx, usage } = await loadCreativeContext(db(), itemId);
      if (usage) track(usage);
      const theme = await loadTheme(db());
      // The logo only when the owner wants it on their posts (Settings → Content)
      const logo = ctx.rules.showLogo ? (theme.logo.onLight ?? theme.logo.onDark) : null;
      // The product's own photos, or for a post about the brand a mix of the brand's and each product's (directPhotos).
      // ctx.assets has no videos, and no people photos when the owner chose none.
      const photos = directPhotos(ctx, MAX_PHOTOS);
      // An ad the owner likes, when they gave one and it's still in storage (it's deleted after 7 days)
      const liked = ctx.item.reference_image_key ? publicUrl(ctx.item.reference_image_key) : null;
      const likedReady = liked ? await fetch(liked, { method: "HEAD" }).then((r) => r.ok).catch(() => false) : false;
      const images: DirectImage[] = [
        ...(liked && likedReady
          ? [
              {
                url: liked,
                what: "an ad the owner likes, from another brand: make this business's ad the same way (layout, composition, style, colours, type and mood). Its brand, logo, words, people and products are not this business's: never copy them",
              },
            ]
          : []),
        ...photos.map((a) => ({
          url: publicUrl(a.storageKey),
          what: a.kind === "product_photo" && a.offeringName ? `real product photo of "${a.offeringName}"${a.description ? `: ${a.description}` : ""}` : `the business's own ${a.kind.replace("_", " ")} photo${a.description ? `: ${a.description}` : ""}`,
        })),
        ...(logo ? [{ url: logo, what: "the brand's logo" }] : []),
      ];
      const colours = { primary: theme.primary.bg, accent: theme.accent.bg, heading: theme.fonts.heading, body: theme.fonts.body };
      const brief = directBrief(ctx, photos[0]?.id ?? null);
      await updateItem(db(), itemId, { brief, captions: brief.captions, hook_type: brief.hook.type, hook_text: brief.hook.text, framework: brief.framework, levers: [], status: "briefed", error: null });
      return { prompt: directPrompt(directContext(ctx, colours, images), !!logo), refs: images.map((i) => i.url), labels: images.map((i) => i.what), brief, imageCount: images.length };
    },
    (r) => `Gathered the business context and ${r.imageCount} image${r.imageCount === 1 ? "" : "s"} for the image model (no brief written by AI)`
  );

  const item = (await step.run("load-item", () => getItem(db(), itemId))) as PlanItem;
  const mediaId = await step.run("start-media", async () => {
    const id = await startMedia(db(), item, prepared.brief, "4:5");
    await updateItem(db(), itemId, { selected_media_id: id });
    return id;
  });

  const producer = taskFor(step, "producer", { businessId, planId, itemId, mediaId });
  const canvases = canvasesFor("static", item.platforms);

  // 2. One request to the image model: the whole context and every image (a remake adds the critic's fix)
  const makeAd = async (round: number, prompt: string): Promise<string> => {
    // The first try keeps its original step names, so runs started before the QA check replay cleanly
    const sfx = round ? `-${round + 1}` : "";
    if (imageEngine() === "openai") {
      // OpenAI's own image model answers with the picture itself
      return producer(
        `direct-openai${sfx}`,
        async (track) => {
          const res = await ai.imageFromReferences(prompt, prepared.refs, { ...openaiImage(), size: openaiImageSize(canvases[0].ratio), fallbackSize: openaiFallbackSize(canvases[0].ratio) });
          track(res.usage);
          const key = workKey(businessId, mediaId, `direct${sfx}.png`);
          await saveFile(db(), mediaId, "thumbnail", key, res.data, "image/png");
          return publicUrl(key);
        },
        () => `OpenAI's image model made the ad from the context and images${round ? " (again, with the critic's fix)" : ""}`
      );
    }
    const started = await producer(
      `direct-start${sfx}`,
      async (track) => {
        if (imageEngine() === "kie-gpt2") {
          // GPT Image 2 on Kie. retried: true so a failure stands instead of silently switching to another model
          const ratio = canvases[0].ratio as "1:1" | "4:5" | "9:16" | "16:9";
          const made = await ai.imageGpt2(prompt, ratio, gpt2Resolution(ratio), prepared.refs);
          track(made.usage);
          return { key: "photo", kind: "image", taskId: made.data, url: null, prompt, aspect: ratio, refs: prepared.refs, retried: true } satisfies KieJob;
        }
        const res = await startJob({ key: "photo", kind: "image", prompt, aspect: kieRatio(canvases[0].ratio), refs: prepared.refs });
        track(res.usage);
        return res.job;
      },
      () => `Sent the context and images to the image model${round ? " (again, with the critic's fix)" : ""}`
    );
    const done = await waitForJobs(step, `direct${sfx}`, [started], {
      first: "12s",
      every: "6s",
      max: 30,
      onRetry: (usage) => logUsage({ agent: "producer", businessId, planId, itemId, mediaId }, usage, "Made the ad again after a failed try"),
    });
    if (!done) throw new NonRetriableError("Making the ad took too long. Try again.");
    return producer(`direct-keep${sfx}`, () => keepPhoto(db(), businessId, mediaId, done[0].url!, `direct${sfx}`), () => "Saved the ad");
  };

  // 3. The QA Critic looks at the finished ad: creativity, golden-ratio composition, the product, the logo, the words, the facts
  const qa = taskFor(step, "qa_critic", { businessId, planId, itemId, mediaId });
  const review = (round: number, adUrl: string) =>
    qa(
      `direct-qa-${round}`,
      async (track) => {
        const message = [
          "THE REQUEST THE IMAGE MODEL GOT:",
          prepared.prompt,
          "",
          "IMAGES, IN ORDER:",
          ...prepared.labels.map((what, i) => `Image ${i + 1}: ${what}`),
          `Image ${prepared.labels.length + 1} (last): the finished ad to judge`,
        ].join("\n");
        let r;
        try {
          const res = await ai.structured(directImageReviewSchema, message, { system: DIRECT_IMAGE_QA_SYSTEM, images: [...prepared.refs, adUrl], model: MODELS.critic });
          track(res.usage);
          r = res.data;
        } catch (err) {
          // A problem retrying won't fix (a vendor refusing the request): report it, don't fail the post
          if (err instanceof AppError && !err.retryable) return { passed: false, score: 0, fix: "", unavailable: err.message, failed: [] as string[] };
          throw err;
        }
        const checks: QaCheck[] = [
          { name: "Creative idea", passed: r.creativity >= 6, detail: `${r.creativity}/10` },
          { name: "Composition (golden ratio)", passed: r.composition >= 6, detail: `${r.composition}/10` },
          { name: "Product matches", passed: r.productMatches !== false, detail: r.productMatches === null ? "No product photo" : undefined },
          { name: "Logo", passed: r.logoOk !== false, detail: r.logoOk === null ? "Not asked for" : undefined },
          { name: "Words readable and spelled right", passed: r.textOk },
          { name: "Only true facts", passed: r.factsOk },
          { name: "Looks real", passed: !r.realismFails.length, detail: r.realismFails.join("; ") || undefined },
        ];
        const passed = r.score >= PASS_SCORE && checks.every((c) => c.passed);
        const item = await getItem(db(), itemId);
        const report: QaReport = {
          ...(item.qa_report ?? {}),
          gate2: { score: r.score, notes: r.issues.join(" "), checks, attempts: round + 1, requiresAiLabel: r.requiresAiLabel },
        };
        await updateItem(db(), itemId, { qa_score: r.score, qa_report: report });
        const failed = checks.filter((c) => !c.passed).map((c) => c.name.toLowerCase());
        return { passed, score: r.score, fix: r.fix || r.issues.slice(0, 2).join(" "), unavailable: null as string | null, failed };
      },
      (r) => (r.unavailable ? `Couldn't run the final check: ${r.unavailable}` : `Checked the finished ad: ${r.score}/10${r.passed ? ", passed" : `, ${r.failed.join(", ") || "below 7"}`}`)
    );

  let photoUrl = await makeAd(0, prepared.prompt);
  let checked = await review(0, photoUrl);
  if (!checked.passed && !checked.unavailable) {
    // Below the bar: made once more with the critic's fix (our cost, not the client's credits)
    photoUrl = await makeAd(1, `${prepared.prompt}\n\nFIX FROM THE LAST TRY (the critic's note): ${checked.fix || "make it more creative, follow the golden-ratio composition, and get the words and logo right"}`);
    checked = await review(1, photoUrl);
  }

  // 4. The model's picture is the final ad; only cropped to each platform's size
  await producer(
    "direct-sizes",
    async () => {
      const res = await request("File storage", photoUrl, {}, 30_000);
      if (!res.ok) throw new NonRetriableError("Couldn't read the saved ad. Try again.");
      const source = Buffer.from(await res.arrayBuffer());
      let mainKey = "";
      for (const [i, canvas] of canvases.entries()) {
        const png = await sharp(source).resize(canvas.width, canvas.height, { fit: "cover" }).png().toBuffer();
        const key = mediaKey(businessId, mediaId, finalName(ratioName(canvas.ratio), 0, "png"));
        if (i === 0) {
          await upload(key, png, "image/png");
          mainKey = key;
        } else await saveFile(db(), mediaId, "rendition", key, png, "image/png", { aspect_ratio: canvas.ratio });
      }
      await markMediaReady(db(), mediaId, mainKey);
      return mainKey;
    },
    () => `Fitted the ad to ${canvases.map((c) => c.ratio).join(", ")}`
  );

  await step.run("sync-cost", () => syncCost(db(), mediaId));
  // Below the bar after the remake, or not checked at all: the owner looks it over before it posts
  const status = checked.passed ? "ready" : "needs_review";
  if (checked.passed) await settle("ready");
  else if (checked.unavailable) await settle("needs_review", { reason: `The finished ad couldn't get its final quality check (${checked.unavailable}). Look it over, or choose Try again.` });
  else await settle("needs_review", { reason: `Still below the bar after one remake (${checked.score}/10): ${checked.failed.join(", ") || "below 7"}. ${checked.fix}`.trim() });
  await step.sendEvent("settled", { name: "plan-item/settled", data: { businessId, itemId, planId, oneOff } });
  return { status };
}
