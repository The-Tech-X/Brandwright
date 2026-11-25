import * as OpenAI from "./openai";
import * as Kie from "./kie";
import * as Firecrawl from "@/providers/crawl/firecrawl";
import * as ScrapeCreators from "@/providers/social/scrapecreators";
import * as Watch from "@/providers/video-understanding/watch";

// One entry point per task. Jobs, routes and agents call `ai`, never a vendor file.
// Every paid call returns { data, usage } so agents can log cost.
export const ai = {
  text: OpenAI.text,
  vision: OpenAI.vision,
  structured: OpenAI.structured,
  embed: OpenAI.embed,

  /** A picture made by OpenAI's image model from a prompt and reference images */
  imageFromReferences: OpenAI.generateImage,
  /** GPT Image 2 on Kie: a picture from a prompt and reference images, in the canvas's own proportions */
  imageGpt2: Kie.createGptImageTask,
  image: {
    create: Kie.createImageTask,
    status: Kie.checkTaskStatus,
  },
  /** Seedance 2.5 on Kie: the whole video in one go (direct video mode) */
  videoFull: Kie.createFullVideoTask,
  video: {
    create: Kie.createVideoTask,
    status: Kie.checkTaskStatus,
  },
  task: {
    error: Kie.taskError,
    resultUrl: Kie.resultUrlOrThrow,
  },


  /** Watches a video ourselves: frames and sound by the bundled ffmpeg, read by OpenAI (vision, audio, speech) */
  analyzeVideo: Watch.analyze,

  crawl: {
    map: Firecrawl.map,
    scrape: Firecrawl.scrape,
    screenshot: Firecrawl.screenshot,
    start: Firecrawl.startCrawl,
    status: Firecrawl.crawlStatus,
  },

  search: {
    google: ScrapeCreators.googleSearch,
  },
  ads: {
    google: ScrapeCreators.googleAds,
    metaAdvertisers: ScrapeCreators.metaAdvertisers,
    meta: ScrapeCreators.metaAds,
    /** One Meta Ad Library ad from its link (Copy a video) */
    metaAd: ScrapeCreators.metaAd,
    /** The Ad library screen: active video ads whose words match a search, a page at a time */
    library: {
      search: ScrapeCreators.metaLibrarySearch,
    },
  },
  social: {
    profile: ScrapeCreators.profile,
    posts: ScrapeCreators.posts,
    post: ScrapeCreators.post,
  },
};

export type { KieAspectRatio, TaskStatus } from "./kie";
export type { AdCreative, LibraryAd, LibraryPage, SocialPost, SocialProfile, WebResult } from "@/providers/social/types";
