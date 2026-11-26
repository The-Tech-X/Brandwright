import { platformMeta } from "@/config/platforms";
import { CTA_LINK_KEY, ctaWords, peopleRule } from "@/core/content/prefs";
import { isImageStyle, styleBrief } from "@/core/content/styles";
import { briefSchema, type Brief, type CtaLink } from "@/core/creative/brief";
import type { CreativeContext } from "./context";

// "Direct" image ads (the mode in config/image-ads.ts): no Creative Director. Everything the Creative Director
// would have read goes to the image model as plain facts, after a short creative brief (directRequest), together
// with the product photos and the logo; the QA Critic then checks the picture. The brief that goes with the post
// is made by code, since the post still needs a title, captions and a call to action.

/** What the images attached to the request are, in order (so the model knows which is the product and which the logo) */
export interface DirectImage {
  url: string;
  what: string;
}

export interface DirectColours {
  primary: string;
  accent: string;
  heading: string;
  body: string;
}

const list = (label: string, values: string[]) => (values.length ? [`${label}: ${values.join("; ")}`] : []);

/** The price as the owner set it (" · price …", or nothing): a service may be "from", per hour, monthly or a quote */
function priceText(price: number | null, currency: string | null, model: string | null): string {
  const amount = `${price} ${currency ?? ""}`.trim();
  if (model === "quote") return " · price on request";
  if (price === null) return "";
  return ` · price ${model === "from" ? `from ${amount}` : model === "hourly" ? `${amount} per hour` : model === "subscription" ? `${amount} (monthly or per package)` : amount}`;
}

/** A post about the brand lists this many products and services, so the range fits in the image model's prompt */
const MAX_RANGE = 12;

/**
 * The photos sent with a direct image or video: the product's own; for a post about the brand, the
 * brand's photos and each product's in turn (the context's order); a product with no photo of its own
 * gets a couple of the brand's own (never another product's, which would pull it into the picture).
 */
export function directPhotos(ctx: CreativeContext, max: number): CreativeContext["assets"] {
  if (!ctx.offering) return ctx.assets.slice(0, max);
  const own = ctx.assets.filter((a) => a.offeringId === ctx.offering!.id);
  return own.length ? own.slice(0, max) : ctx.assets.filter((a) => !a.offeringId).slice(0, 2);
}

/** The business, the post and the research as plain text: the same information the Creative Director gets. */
export function directContext(ctx: CreativeContext, colours: DirectColours | null, images: DirectImage[]): string {
  const b = ctx.bible;
  const it = ctx.item;
  const lines: string[] = [];

  lines.push(`BUSINESS: ${ctx.business.name} (language: ${ctx.business.language})`, `About: ${ctx.business.description}`);
  if (ctx.business.yearsInBusiness) lines.push(`In business for ${ctx.business.yearsInBusiness} years`);
  if (ctx.business.goals.length) lines.push(`Goals, in order: ${ctx.business.goals.join(", then ")}`);
  if (b.positioning) lines.push(`Positioning: ${b.positioning}`);
  if (b.valueProp) lines.push(`Value proposition: ${b.valueProp}`);

  lines.push("", "VOICE", `Tone sliders: ${ctx.business.tone}`);
  if (b.tone) lines.push(`Tone: ${b.tone}`);
  lines.push(...b.traits.map((t) => `- ${t}`));
  lines.push(...(b.examples.length ? [`Example lines: ${b.examples.map((e) => `"${e}"`).join(" ")}`] : []), ...list("Do", b.dos), ...list("Don't", b.donts));
  const never = [...new Set([...ctx.avoidWords, ...b.neverSay])];
  lines.push(...list("Never say", never));

  const st = b.strategy;
  if (st) {
    lines.push("", "MARKET", `Sophistication: ${st.sophistication}/5${st.sophisticationWhy ? ` (${st.sophisticationWhy})` : ""}`);
    lines.push(...list("Desires buyers bring", st.desires), ...list("Beliefs they hold", st.beliefs), ...(st.identity ? [`Who they become: ${st.identity}`] : []));
    if (st.mechanism) lines.push(`How it works differently: ${st.mechanism.text}`);
    lines.push(...list("Brand cues", st.distinctiveAssets));
  }

  lines.push("", "BRAND LOOK");
  if (colours) lines.push(`Colours: primary ${colours.primary}, accent ${colours.accent}`, `Fonts: ${colours.heading} (headings), ${colours.body} (text)`);
  if (ctx.photoStyle) lines.push(`Photo style: ${ctx.photoStyle}`);
  if (ctx.layoutStyle) lines.push(`Layout style: ${ctx.layoutStyle}`);
  if (ctx.designLanguage) lines.push(`Design language (the brand's website: its signature look and how it moves): ${ctx.designLanguage}`);
  lines.push(...list("Visual rules", b.visualRules));

  lines.push("", "THIS POST", `Platforms: ${it.platforms.map((p) => platformMeta(p).label).join(", ")}`, `Angle: ${it.angle ?? "brand post"}`);
  if (it.objective) lines.push(`What it should do: ${it.objective}`);
  if (!ctx.offering) lines.push(`Product: none picked, so no single product or service is the star of this post${ctx.range.length ? "; where it shows what the business sells, it shows the range (WHAT THE BUSINESS SELLS)" : ""}`);
  if (it.ad_objective) lines.push(`Objective: ${it.ad_objective}`);
  if (it.desire) lines.push(`Desire: ${it.desire}`);
  if (it.awareness_level) lines.push(`Audience awareness: ${it.awareness_level}`);
  if (it.style && isImageStyle(it.style)) lines.push(`Content style the owner chose: ${styleBrief(it.style, "static")}`);
  const people = peopleRule(ctx.rules.people);
  if (people) lines.push(`People: ${people}`);
  if (ctx.pillar) lines.push(`Content pillar: ${ctx.pillar.name}${ctx.pillar.description ? ` (${ctx.pillar.description})` : ""}`);

  if (ctx.persona) {
    const p = ctx.persona;
    lines.push("", `AUDIENCE: ${p.name}`, ...(p.summary ? [p.summary] : []), ...list("Pains", p.pains), ...list("Desires", p.desires), ...list("Objections", p.objections), ...list("Buying triggers", p.triggers), ...list("Words they use", p.phrases));
  }

  if (!ctx.offering && ctx.range.length) {
    const shown = ctx.range.slice(0, MAX_RANGE);
    lines.push(
      "",
      "WHAT THE BUSINESS SELLS",
      ...shown.map((o) => {
        const about = o.description?.replace(/\s+/g, " ").trim();
        return `- ${o.kind === "service" ? "Service" : "Product"}: ${o.name}${priceText(o.price, o.currency, o.priceModel)}${about ? ` · ${about.length > 110 ? `${about.slice(0, 110).trimEnd()}…` : about}` : ""}`;
      }),
      ...(ctx.range.length > shown.length ? [`- and ${ctx.range.length - shown.length} more`] : [])
    );
  }

  if (ctx.offering) {
    const o = ctx.offering;
    const price = priceText(o.price, o.currency, o.priceModel);
    const a = o.attributes ?? {};
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const steps = Array.isArray(a.process) ? a.process.filter((s): s is string => typeof s === "string" && !!s.trim()) : [];
    const where = [text(a.area), text(a.areas)].filter(Boolean).join(": ");
    lines.push(
      "",
      `${o.kind === "service" ? "SERVICE" : "PRODUCT"}: ${o.name}${price}${o.description ? ` · ${o.description}` : ""}`,
      ...(text(a.included) ? [`What's included: ${text(a.included)}`] : []),
      ...(text(a.turnaround) ? [`Turnaround: ${text(a.turnaround)}`] : []),
      ...(steps.length ? [`How it works: ${steps.map((s, i) => `${i + 1}. ${s}`).join(" ")}`] : []),
      ...(where ? [`Where it's offered: ${where}`] : []),
      ...list("Benefits", o.benefits),
      ...(o.audience ? [`For: ${o.audience}`] : []),
      ...list("Objections and FAQs", o.objections)
    );
  }
  if (ctx.offer) {
    const o = ctx.offer;
    lines.push("", `OFFER: ${o.title}${o.details ? ` · ${o.details}` : ""}${o.code ? ` · code ${o.code}` : ""}${o.endsAt ? ` · ends ${o.endsAt.slice(0, 10)}` : ""}`);
  }
  if (ctx.proof.length) {
    // Reviews, and for services also case studies, certifications and awards
    lines.push("", "REVIEWS AND PROOF");
    ctx.proof.forEach((p) => lines.push(`- ${p.kind}${p.author ? ` by ${p.author}` : ""}${p.rating ? ` (${p.rating}/5)` : ""}: ${p.content}`));
  }
  if (ctx.passages.length) {
    lines.push("", "FROM THE WEBSITE");
    ctx.passages.forEach((p) => lines.push(`- ${p.text.replace(/\s+/g, " ")}`));
  }

  lines.push("", "WHERE PEOPLE GO NEXT");
  lines.push(...Object.entries(ctx.ctaLinks).map(([k, v]) => `${k}: ${v}`));
  if (ctx.rules.cta) lines.push(`Owner's chosen next step: ${ctaWords(ctx.rules.cta)}`);

  if (images.length) lines.push("", "ATTACHED IMAGES", ...images.map((im, i) => `Image ${i + 1}: ${im.what}`));
  return lines.join("\n");
}

/**
 * What goes to the image model: the request and a short creative brief (concept, golden-ratio composition, the
 * words), then everything above. Left to itself the model made plain product photos with no words. The model never
 * draws the logo (it redraws it badly, in a painted box): it keeps the top corners clear and our code places the
 * real logo file there (creative/logo-overlay.ts) when the owner shows it.
 */
export const directRequest = (logo: boolean) =>
  [
    "Create one new, scroll-stopping ad image for this business's post, based on the details below. The attached images are references (see ATTACHED IMAGES): make a new picture, not a collage or a copy of them.",
    "",
    "HOW TO MAKE IT",
    "- Concept: one bold, creative idea that brings the post's angle (THIS POST) to life through a striking setting, styling, light or point of view, at the level of a top agency campaign. Never a plain catalogue shot or a copy of the reference photo.",
    "- Product: what is sold looks exactly like its photos (shape, colours, pattern, details). A person in a product photo is not part of the product: show a new person or none, as the People line says.",
    "- Composition: golden ratio. The main subject sits on a golden-ratio line or point (about 0.618 of the width or height, not dead centre unless the concept needs symmetry); the words sit in the calm, open part of the picture, balanced against the subject; nothing important touches the edges.",
    "- Words: a short headline (3–8 words) that carries the angle, and at most one short supporting line (the offer, the price as given, or the next step). Write them in the business's language, spelled exactly, large, crisp and easy to read against what is behind them, in a typeface that suits the brand. Only facts from the details: no invented prices, discounts, ratings, reviews or claims. No buttons, links, web addresses, phone numbers or hashtags, and none of the labels below (Angle, Objective, Desire…); nothing else is written anywhere.",
    logo
      ? "- Logo: don't draw any logo, signature or brand mark. Keep the top-left and top-right corners calm and free of words and the main subject: the brand's real logo is added in one of them afterwards."
      : "- Logo: no logo goes on this ad. Don't draw one or invent a brand mark.",
    "- Colours: the brand's colours (BRAND LOOK) where they fit. Colour codes are values, never text to write.",
    "- An ad the owner likes (when ATTACHED IMAGES has one): make this ad the same way, with its layout, composition, camera angle, styling, type and mood. It comes before the concept and composition lines above; the product, the words, the facts and the logo are still this business's, never the other brand's.",
  ].join("\n");

/** Kie's prompt box is large but not endless; the context rarely comes near this. */
const MAX_PROMPT = 12_000;

/** The research labels the Brand Bible keeps for itself: "(sources: ["A2", "O1"])" means nothing to a picture */
const withoutSources = (text: string) => text.replace(/\s*\(sources: \[[^\]]*\]\)/g, "");

export function directPrompt(context: string, logo: boolean): string {
  const text = withoutSources(`${directRequest(logo)}\n\n${context}`);
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT).trimEnd()}…` : text;
}

/** The post's brief, made by code (no AI): a title, a caption per platform and the call to action. */
export function directBrief(ctx: CreativeContext, referenceAssetId: string | null): Brief {
  const it = ctx.item;
  const angle = (it.angle ?? "").trim() || `${ctx.offering?.name ?? ctx.business.name}`;
  const key = ctx.rules.cta ? CTA_LINK_KEY[ctx.rules.cta] : null;
  const link: CtaLink = (key && ctx.ctaLinks[key] ? key : "website") as CtaLink;
  const next = ctx.rules.cta ? ctaWords(ctx.rules.cta) : "Learn more";
  const url = ctx.ctaLinks[link] ?? ctx.ctaLinks.website ?? "";
  const captions: Record<string, string> = {};
  for (const platform of it.platforms) {
    const text = [angle, [next, url].filter(Boolean).join(" · ")].filter(Boolean).join("\n\n");
    captions[platform] = text.slice(0, platformMeta(platform).captionMaxLength);
  }
  return briefSchema.parse({
    kind: "static",
    message: angle.slice(0, 300).padEnd(5, "."),
    hook: { type: "bold_claim", text: angle.slice(0, 200).padEnd(3, ".") },
    framework: "aida",
    levers: [],
    cta: { label: next.split(/\s+/).slice(0, 4).join(" ").slice(0, 40).padEnd(2, "."), link },
    claims: [],
    captions,
    referenceAssetId,
    style: it.style,
    headline: angle.slice(0, 80).padEnd(2, "."),
    imagePrompt: "Direct ad: the image model made the whole ad from the full business context and the attached images.",
    layout: "spotlight",
  });
}
