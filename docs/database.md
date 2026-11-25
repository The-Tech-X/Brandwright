# Database Schema

32 business tables + `businesses`, plus `admins` and `credit_prices` (no business) in Supabase Postgres; files are in Cloudflare R2 (see File storage). This file describes every table and rule; `supabase/schema.sql` creates them.

## The schema file

`supabase/schema.sql` is the whole database in one file, always current: extensions, every table with its columns, checks, foreign keys and indexes, triggers, RLS policies, grants, functions and the `credit_prices` rows. There are no migration files.

- **New project**: paste `schema.sql` into the Supabase SQL Editor and run it once, before any login exists (Database → Extensions: `vector` in schema `extensions`; the file also creates it). Then make the first admin with `npm run smoke scripts/setup/admin.ts <email>`.
- **A change**: edit the table or function where it lives in `schema.sql` (it must still run on an empty project); on a database that already exists, run just that change in the SQL Editor once; update this file; regenerate `src/types/database.ts`.
- Keep constraint names: API embeds name foreign keys (e.g. `plan_items!posts_plan_item_id_fkey`).
- Not in the file on purpose: the old Supabase Storage bucket (files are in R2) and data moves for databases from before multi-tenant.

## Rules

- **One business per login**: every table has `business_id` (not null, `on delete cascade` from `businesses`). See Multi-tenant below.
- **Settings rows**: `business_profile`, `app_settings`, `brand_kit` have one row per business (primary key `business_id`), created with the business.
- **Archive, don't delete**: `offerings`, `offers`, `personas`, `content_pillars` use `active = false`. `SET NULL` foreign keys are only a safety net.
- **Facts trace to a source**: extracted `offerings`/`offers`/`proof_items` keep a `source_id` (or came from the client) and stay inactive/unverified until the client confirms.
- **Storage keys, never URLs** in every `storage_key` / `logo_key` column.
- **Embeddings**: `vector(1536)` for OpenAI `text-embedding-3-small`; searched exactly within one business (no shared vector index). Changing the model = changing both columns in `schema.sql` + re-embed.
- **Access**: RLS on every table, one policy `own_business` for the `authenticated` role (`business_id = current_business_id()`). No `anon` privileges. Jobs and agents use the service role through `businessDb(businessId)`, which filters and stamps `business_id` itself.
- `updated_at` is maintained by the `set_updated_at` trigger where the column exists.

## Multi-tenant

### `businesses` — new
One row per business: `id` uuid PK, `owner_id` → `auth.users` (the login that made it; `on delete set null`, so deleting a login keeps its data), `owns_unfoldered_files` (true for the first business: only it may delete files outside a business folder; false on a new project), `credits` (integer, never below 0: the balance, changed only by the `credit_*` functions), `fees_due` (jsonb: a monthly fee that couldn't be taken, `{credits, label, key, action, since}`; publishing waits while it's set), `created_at`. Logged-in users can read the businesses they belong to (`member_reads`) and never write them.

### `business_members` — new
Which logins can open which business: `user_id` → `auth.users` (cascade), `business_id` → `businesses` (cascade), `role` (`owner`: made with or by this login; `member`: linked by signing in once with that business's own login), `created_at`; primary key (`user_id`, `business_id`). A login reads only its own rows; only the server writes them.

- `current_business_id()`: the business this request is for (security definer). Column default of every `business_id`, used by every RLS policy. It reads the `x-brandwright-business` request header (the browser tab's business) when the login belongs to it, else none; or the `x-brandwright-pick` header (the business picked on this device) when the login belongs to it; else the login's own first business.
- `business_login_email()`: the open business's own login email (its owner's), for the account menu.
- `my_businesses()`: the login's businesses with name, logo, onboarding status and role, for the account menu. `create_business()`: "Add account" → a new business the login owns (its unfinished setup when it has one; at most 25 per login).
- Trigger `brandwright_create_business` on `auth.users`: every new login gets a business and is its owner (`business_members`); a login made with `app_metadata.role = 'admin'` gets none and is listed in `admins` instead. Trigger `seed_business` on `businesses`: creates its `business_profile`, `app_settings` (notification email = the owner's email) and `brand_kit` rows.
- Trigger `keep_business_id` on every table: a row can never move to another business.
- Trigger `guard_server_columns`: only the server may set `app_settings.zernio_profile_id`, `app_settings.monthly_budget_usd`, `post_targets.provider_ref` and `post_targets.provider_post_id`; logged-in users may only clear them.

### `admins` — new
The admin panel's logins: `user_id` PK → `auth.users` (cascade), `created_at`. RLS on with no policies: only the server reads it, and `is_admin()` (security definer) tells a logged-in user whether they are one. An admin has no business.

## Credits

### `credit_prices` — new
What each action costs: `action` PK (`onboarding`, `brand_refresh`, `market_refresh`, `bible_regenerate`, `brand_video`, `week_plan`, `image_ad`, `image_ad_reference`, `carousel`, `text_post`, `video`, `video_copy`, `social_account`), `credits`, `label`, `sort`, `updated_at`. Every login reads it; only the server (the admin panel's Prices) changes it. Not per business.

### `credit_ledger` — new
Every change to a balance: `id`, `business_id` (cascade), `kind` (`topup`: an admin added credits; `adjust`: an admin removed some; `charge`: an action used them; `refund`: a charge given back), `credits` (+ added, - taken), `balance` (after this row, never below 0), `action` (`credit_prices.action`; null for top-ups), `label` (what the client sees, e.g. "Image ad · Summer sale"), `ref_id` (the slot, plan, media item, research run or asset), `amount_usd` (what was paid for a top-up, optional), `note` (admins only), `key` (unique per business: the same key is charged once), `refund_of` → the charge a refund gives back (unique), `created_by` → the admin (`on delete set null`), `created_at`. A logged-in business reads its own rows, but not `note`, `key` or `created_by` (column grants); only the server writes them (no insert, update or delete grants).

Functions: `credit_balance(p_business_id)` (security invoker: the balance and fee due of the logged-in business, or the one a job passes); `credit_spend(p_business_id, p_credits, p_action, p_label, p_ref_id, p_key)` (locks the business row; raises `NO_CREDITS needed=… have=…` when short; a used key charges nothing again); `credit_refund(p_business_id, p_key, p_label)` (gives back that key's charge once); `credit_topup(p_business_id, p_credits, p_amount_usd, p_note, p_admin)` (adds, or removes with a negative number, never below 0). Admin reads: `admin_businesses(p_business_id)` (every business with login email, setup, balance, fee due, safety cap, credits used this month and in 30 days, credits added, money paid, last top-up, our AI cost this month, posts in 30 days, last activity), `admin_usage(p_since, p_until, p_business_id)` (credits used and times per business and action), `admin_series(p_since, p_until, p_unit, p_business_id)` (per day, week or month: credits used and added, money paid, our AI cost), `admin_ai_cost(p_since, p_until)` (per business). The credit and admin functions run only with the service role.
- A new project starts empty: every business comes from a login.

## Settings (one row per business)

### `business_profile` — changed
The client's onboarding answers. Every agent reads it first.

| Column | Type | Notes |
|---|---|---|
| `business_id` | uuid PK | The business |
| `name`, `logo_key`, `website` | text | Kept |
| `description` | text | Replaces `about`. 2–3 lines, max 1,500 chars |
| `business_type` | text | `product` \| `service` — picks the products or services step |
| `language` | text | Default `en`. Copy and voice language |
| `timezone` | text | e.g. `Asia/Kolkata` |
| `countries` | text[] | ISO 3166-1 codes in priority order (first = main market), e.g. `{MT,IT}`. Names via `countryName()` in `src/config/countries.ts` |
| `primary_goal` | text | `awareness` \| `leads` \| `sales` \| `bookings` \| `followers`. Always the first of `content_prefs.goals` |
| `content_prefs` | jsonb | "Your content" answers: `{goals (1–2, in order), mix (images \| mostly-images \| balanced \| mostly-videos), image_styles, video_styles (up to 5 each, in order), people (real \| ai \| none), logo (every \| never)}` |
| `industry` | text | One of the onboarding industries. Health, beauty and finance get extra ad-rule checks |
| `currency` | text | ISO code. Default for every new price |
| `cities` | text[] | Cities served, empty = nationwide |
| `primary_cta` | text | `shop` \| `whatsapp` \| `book` \| `call`: the one next step on every post; the link is in `cta_links` |
| `social_urls` | jsonb | `{instagram, facebook, …}` |
| `cta_links` | jsonb | `{website, shop, booking, whatsapp, phone, lead_magnet}` |
| `tone` | jsonb | Sliders 0–100: `formal`, `playful`, `bold`, `technical` |
| `compliance` | jsonb | `{avoid_words, forbidden_claims, disclaimers}` — QA hard rule |
| `posting_prefs` | jsonb | `{platforms: posts per week, formats}` |
| `voice_id`, `music_mood` | text | Video defaults |
| `onboarding` | jsonb | Wizard progress and answers with no column: `step` (furthest step), `area`, `areas`, `yearsInBusiness`, `faqs`, `voiceName`, `runId`, `submittedAt`, `scan` (website scan, see technical.md), `research` (brand research progress) |
| `onboarding_status` | text | `not_started` → `collecting` → `analyzing` → `review` → `done` |
| `updated_at` | timestamptz | |

Removed: `about` (→ `description`), `products` (→ `offerings`), `liked_brands` (→ `competitors` with `relation = 'inspiration'`).

### `app_settings` — new
How the system behaves, kept apart from brand facts so agents never see it in prompts.

| Column | Type | Notes |
|---|---|---|
| `business_id` | uuid PK | The business |
| `autopilot_mode` | text | `full` \| `approve_plan` \| `approve_each` (default `approve_each`) |
| `paused` | boolean | Kill switch: stops all agent work |
| `auto_plan` | boolean | "Plan my week automatically": the weekly cron plans and makes next week's posts only when on. Default off |
| `plan_weekday`, `plan_time` | smallint (0 = Sunday), time | When the weekly plan runs (with `auto_plan` on). Default Sunday 09:00 |
| `approval_timeout_hours` | int | Auto-approve after this, full mode only. Default 24 |
| `monthly_budget_usd` | numeric | The monthly AI safety cap: agents stop when this month's `agent_runs.cost_usd` reaches it (summed by `month_spend()`). Brandwright's own guard, set in the admin panel; only the server may change it. Default 50 |
| `notify_email` | text | Plan-ready and failure emails |
| `zernio_profile_id` | text | This business's own Zernio profile. Created on first accounts or connect call, never the account's default |

### `brand_kit` — new
Visual identity as exact values, so code draws on-brand ads.

| Column | Type | Notes |
|---|---|---|
| `business_id` | uuid PK | The business |
| `colors` | jsonb | `{primary, secondary, accent, bg, text}` |
| `fonts` | jsonb | `{heading, body}` |
| `logo_variants` | jsonb | Storage keys: `{full, mark, light, dark}` |
| `photo_style`, `layout_style` | text | Described by AI vision |
| `design_language` | text | The website's signature look and motion: components, recurring motifs, how images and screens are shown, how it animates. Written by AI vision from screenshots of the homepage and two key pages, with the motion our code reads from the site's code. Image and video prompts use it; editable in Brand → Brand kit |
| `template_ids` | text[] | Ad layouts this brand uses |

## Brand knowledge

### `brand_bible` — new
Versioned strategy document. Only one row per business can be `approved` (partial unique index).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `version` | int | Increments on each edit; unique per business |
| `status` | text | `draft` \| `approved` \| `superseded` |
| `content` | jsonb | `positioning, value_prop, tone_guide {summary, traits, examples}, visual_rules, offer_stack [{offeringId, name, role, pitch, pending}], do_dont {do, dont}, never_say, personas, pillars, note`. Every statement is a claim `{text, sources}`; schema in `src/core/brand/bible.ts` |
| `approved_at`, `created_at` | timestamptz | |

### `personas` — new
`id`, `name`, `summary`, `pains`/`desires`/`objections`/`triggers`/`phrases` (text[]), `active`, timestamps. Own table so plan items and learnings point at a persona by id. Written when a Bible version is approved (its personas replace the active ones, old ones archived) and editable in Brand → Personas.

### `content_pillars` — new
`id`, `name`, `description`, `target_share` (0–1), `funnel_stage` (`tofu`\|`mofu`\|`bofu`), `active`, timestamps. Written on Bible approval like personas.

### `offerings` — new
Products and services in one table (replaces `business_profile.products`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | text | `product` \| `service` |
| `name`, `description`, `url` | text | |
| `price`, `currency` | numeric, text | |
| `price_model` | text | `fixed` \| `from` \| `hourly` \| `quote` \| `subscription` |
| `benefits`, `objections` | text[] | |
| `audience` | text | |
| `is_hero`, `priority` | boolean, smallint | Hero items get more slots |
| `attributes` | jsonb | Product: variants, specs. Service: process, turnaround, area |
| `active` | boolean | Archive instead of delete |
| `source_id` | uuid FK → `brand_sources` | Page it was found on (null = entered by the client). |
| `verified` | boolean | `true` for client rows. Extracted rows start `active = false, verified = false`; confirm sets both true, reject keeps `active = false, verified = true` |

### `offers` — new
`id`, `offering_id` (null = store-wide), `title`, `details`, `code`, `starts_at`, `ends_at`, `active`, `source_id`, `verified` (same rules as `offerings`). Urgency copy is allowed only while an active offer backs it.

### `proof_items` — new
`id`, `offering_id` (null = whole business), `source_id`, `kind` (`review`\|`testimonial`\|`case_study`\|`stat`\|`award`\|`certification`), `content`, `author`, `rating` (0–5), `verified`.

### `brand_assets` — new
`id`, `offering_id`, `source_id` (the website page a found photo came from), `kind` (`product_photo`\|`team`\|`location`\|`work`\|`reference_video`\|`doc`\|`person`\|`reference_image`\|`general`), `storage_key`, `ai_description` (one line about a photo, or a video's summary), `tags`, `analysis`.

- The client's own: `product_photo`, `team`, `location`, `work`, `person` (people who appear in posts), `general` (other own photos and videos). Ads use them directly or as reference images.
- Other brands' posts the client likes (onboarding's "Reference posts and ads"): `reference_image`, `reference_video`. Studied for style and pacing, never used as the client's own. A video to copy for one post is a `reference_videos` row instead.
- `analysis` (own videos only): `{duration, summary, orientation, moments: [{start, end, shows, shot, people, talking, product, quality, use, subject {x, y}, textArea, lines [{start, end, text}]}]}` from one Twelve Labs read; `{error}` when the video couldn't be read; null for photos and videos not watched yet. Partial index `idx_brand_assets_unwatched` finds the unwatched ones.

### `reference_videos` — new
Every video the owner gave to copy ("Copy a video"). A video someone liked enough to copy says something about what works, so its breakdown is kept for good, for later learning. The file is not kept.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `plan_items.reference_video_id` points here (the post it was copied for) |
| `source` | text | `upload` \| `link` |
| `source_url` | text | The pasted link; null for uploads |
| `platform` | text | `meta_ad` \| `instagram` \| `tiktok` \| `youtube` \| `facebook` \| `other` (a direct video file); null for uploads |
| `source_meta` | jsonb | What the link's page said: Meta ads `{pageName, text}`; posts `{caption, publishedAt, views, likes, comments, shares, saves}`; `{}` for uploads |
| `offering_id` | uuid FK → `offerings` | The product it was copied for |
| `media_id` | uuid FK → `media` | The latest video made from it (set when the video is saved) |
| `storage_key` | text | The file while it's read: `tmp/<business id>/reference/<id>.<ext>`, deleted by R2 after 7 days. Rows moved from `brand_assets` keep their old key |
| `analysis` | jsonb | The scene-by-scene breakdown (`prompts/agents/reference-video.ts`: duration, summary, pacing, scenes, speech, sound, look, ending); null until read |
| `summary`, `duration_sec`, `analyzed_at` | text, numeric, timestamptz | From the breakdown, for lists and searches |
| `created_at` | timestamptz | |

### `competitors` — new
`id`, `name`, `website`, `social_urls`, `analysis` (`{positioning, angles, offers, formats, hooks, gaps, followers, activeAds}`), `analyzed_at`, `source` (`client` \| `discovered` by the Social & Market Analyst; the wizard only shows and edits `client` rows), `relation` (`competitor` \| `inspiration`: brands the client admires are studied for style but never treated as rivals).

### `calendar_events` — new
`id`, `date`, `name`, `kind` (`holiday`\|`sale`\|`launch`\|`trend`), `relevance` (1–5), `source` (`system`\|`client`\|`serp`; `serp` is unused since SerpAPI was dropped), `notes`.

## Brand Brain

### `brand_sources` — new
Every raw document read: `id`, `kind` (`web_page`\|`social_post`\|`competitor`\|`serp` (unused)\|`review`\|`upload`\|`reference`: a post link the client pasted in onboarding), `competitor_id`, `url`, `title`, `content_md`, `content_hash` (skip unchanged pages), `metadata`, `fetched_at`.

### `brand_chunks` — new
`id`, `source_id`, `content` (300–800 words), `embedding vector(1536)`, `metadata` (`{offering_id, kind}`, GIN-indexed for filters).

Search with:

```sql
select * from match_brand_chunks(query_embedding, match_count => 8, filter => '{"kind": "web_page"}', p_business_id => '<business id>');
-- p_business_id: needed for the service role (businessDb adds it); logged-in users get their own business
-- returns id, source_id, content, metadata, similarity (1 = identical)
```

## Planning & creative

### `content_plans` — new
`id`, `week_start` (a Monday, unique per business), `brand_bible_id`, `status` (`planning`\|`producing`\|`review`\|`approved`\|`scheduled`\|`done`\|`failed`), `strategy` (`{theme, rationale, mix: [{pillarId, name, target, planned}], events, adhoc}`), `approved_at`, `approval_due_at` (full autopilot), `error`.

### `plan_items` — new
The core table: one row per slot with every creative decision.

| Column | Type | Notes |
|---|---|---|
| `id`, `plan_id` | uuid | |
| `slot_at` | timestamptz | When it posts |
| `platforms` | text[] | |
| `format` | text | `static` \| `carousel` \| `video` \| `text` |
| `style` | text | The client's image or video style for the slot (`tips`, `showcase`…; `IMAGE_STYLES` / `VIDEO_STYLES` in `core/onboarding/options.ts`), picked by the Planner's code. Null for text posts and older plans |
| `pillar_id`, `persona_id`, `offering_id`, `offer_id` | uuid FKs | |
| `funnel_stage`, `objective` | text | |
| `reference_image_key` | text | Image ads: an ad image the owner likes, `tmp/<business id>/reference/<id>.<ext>`; sent to the image model with the rest of the context (direct image ads). Gone after 7 days, then a redo is made without it |
| `reference_video_id` | uuid FK → `reference_videos` | A reference video for this post: its scene-by-scene breakdown is saved on that row's `analysis` and the video is made the same way for the product. Null for most posts |
| `ad_objective`, `desire`, `awareness_level` | text | The Planner's strategy for the slot: what it is for, the one desire it taps, the audience's awareness. Null on older plans |
| `angle`, `framework`, `hook_type`, `hook_text` | text | Tags the learning loop scores |
| `levers` | text[] | `social_proof`, `scarcity`, `authority`… |
| `is_experiment` | boolean | The 30% exploration |
| `brief` | jsonb | The creative brief (`core/creative/brief.ts`): message, hooks, CTA, claims, captions, and per format the headline and layout, the slides, or the video scenes with their sources, sound and look |
| `captions` | jsonb | `{platform: text}` |
| `rationale` | text | Shown to the client |
| `brief_score`, `qa_score` | numeric | QA Gate 1 and Gate 2 |
| `qa_report` | jsonb | |
| `attempts` | smallint | Regeneration count (max 2) |
| `status` | text | `planned` → `briefed` → `producing` → `ready` (passed both QA gates) or `needs_review` → `approved` → `scheduled` → `published`; or `rejected` (skipped by the client), `failed`. `qa` is allowed but unused |
| `selected_media_id` | uuid | The asset that passed QA |
| `error` | text | Plain message |

### `hook_library` — new
`id`, `text`, `hook_type`, `platform`, `source` (`generated`\|`own_winner`\|`competitor`\|`reference`), `plan_item_id`, `score`, `uses`, `embedding vector(1536)` (similarity check against recent hooks).

## Media

### `media` — changed
Every asset, made by an agent or by hand (`plan_item_id` null for manual).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `type` | text | `image` \| `video` \| `text` \| `carousel` |
| `source` | text | `generated` \| `uploaded` |
| `status` | text | `generating` \| `ready` \| `failed` |
| `idea`, `content`, `aspect_ratio`, `use_logo`, `duration_sec`, `voice_id`, `reference_image_key`, `storage_key`, `error`, `created_at` | | Kept |
| `voice_name`, `audio_style`, `character`, `language` | text | Video inputs (were schema drift) |
| `plan_item_id` | uuid | Null for manual media |
| `offering_id` | uuid | Replaces the `product` text column |
| `variant_of` | uuid | Regenerated version of another row |
| `creative_spec` | jsonb | Everything needed to regenerate. Manual "Other" product: `{product_name}` |
| `video_analysis` | jsonb | Twelve Labs result |
| `cost_usd` | numeric | Sum of vendor costs |

### `media_files` — new
`id`, `media_id`, `role` (`slide`\|`rendition`\|`thumbnail`\|`voice`\|`music`\|`subtitles`), `position`, `aspect_ratio`, `storage_key`. A carousel is one `media` row with its slides here.

## Publishing & performance

### `posts` — changed
`id`, `media_id` (restrict), `status` (`draft`\|`scheduled`\|`publishing`\|`published`\|`partial`\|`failed`), `publish_at`, `created_at`, plus `plan_item_id` (unique, null for manual) and `origin` (`manual`\|`agent`).

### `post_targets` — changed
One row per account per post. Kept: `id`, `post_id`, `platform`, `account_id`, `account_name` (copied at post time), `caption`, `provider`, `status` (`pending`\|`sending`\|`published`\|`failed`), `provider_ref`, `url`, `error`; unique `(post_id, platform, account_id)`. New: `provider_post_id` (for metrics), `published_at`. `provider` defaults to `zernio`; older rows keep `upload-post`.

### `post_metrics` — new
One row per target per day for the first 30 days: `post_target_id`, `captured_on` (unique together), `impressions`, `reach`, `views`, `likes`, `comments`, `shares`, `saves`, `clicks`, `followers_gained`, `avg_watch_sec`, `completion_rate`, `engagement_rate`, `raw`.

### `account_snapshots` — new
`platform`, `account_id`, `captured_on` (unique together per business), `followers`, `raw`.

### `learnings` — new
`dimension` (`baseline`\|`angle`\|`hook_type`\|`format`\|`style`\|`framework`\|`lever`\|`pillar`\|`persona`\|`time_slot`\|`ad_objective`\|`desire`\|`awareness_level`\|`style_modifier`), `value` (name, or id as text — no FK on purpose), `platform` (null = all), `sample_size`, `score` (1.0 = baseline), `confidence`, `insight`. Unique on `(business_id, dimension, value, platform)` with nulls not distinct. Baselines: `dimension = baseline`, `value = engagement_rate` or `views`, `score` = the median itself.

### `feedback` — new
`plan_item_id`, `media_id`, `action` (`approve`\|`reject`\|`edit`\|`regenerate`), `note`.

## System

### `ad_library_searches` — new
Each page of Meta Ad Library results the business fetched (Copy a video → Ad library). Every live call costs a ScrapeCreators credit, so a page is read from here for 48 hours (`LIMITS.adLibraryCacheHours`); rows older than that are deleted by the app when it saves a new page. Today's rows (UTC) count the live calls against `LIMITS.adLibraryCallsPerDay`.

| Column | Type | Notes |
|---|---|---|
| `kind` | text | `keyword` (ads whose words match: the only kind the screen uses) or `brand` (one advertiser's ads, allowed but unused) |
| `query` | text | What was searched, lower-cased and trimmed |
| `country` | text | ISO 3166-1 code, or `ALL` |
| `page` | integer | 1, 2… (unique per business, kind, query and country) |
| `ads` | jsonb | The page's video ads: `id`, `brand`, `brandImage`, `text`, `videoUrl`, `previewUrl`, `startedAt`, `platforms`, `link` (Meta's video links expire after a few days) |
| `next_cursor` | text | Where the next page starts; null on the last page |
| `fetched_at` | timestamptz | When the live call was made |

No foreign keys. An ad picked from here is copied through its Ad Library link: `reference_videos.source_url` is always `https://www.facebook.com/ads/library/?id=<id>` for a Meta ad, so a video copied again reuses its breakdown.

### `agent_runs` — new
One row per agent step: `agent`, `run_id` (groups one workflow run, e.g. one onboarding research), `plan_id`, `plan_item_id`, `media_id`, `inngest_run_id`, `status` (`running`\|`done`\|`failed`), `summary` (shown in the activity feed), `input`, `output`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `error`, `created_at`. Powers the activity feed, our cost per business (admin panel) and the monthly safety cap.

### `notifications` — new
`kind` (`plan_ready`, `ad_ready`, `item_needs_review`, `plan_scheduled`, `post_failed`, `agent_stopped`, `budget_reached` (the monthly safety limit), `credits_low` (publishing paused by an unpaid account fee), `weekly_report`), `title`, `body`, `link` (app path), `read_at`, `created_at`, plus `email_status`, `email_to`, `email_error`, `emailed_at`.

## Foreign keys (29)

Every one also includes `business_id` (`(col, business_id) → parent (id, business_id)`), so it can only point inside the same business. RESTRICT is now NO ACTION (same error for a normal delete).

| Child column | Parent | On delete |
|---|---|---|
| `offers.offering_id` | `offerings` | CASCADE |
| `offerings.source_id` | `brand_sources` | SET NULL |
| `offers.source_id` | `brand_sources` | SET NULL |
| `proof_items.offering_id` | `offerings` | SET NULL |
| `proof_items.source_id` | `brand_sources` | SET NULL |
| `brand_assets.offering_id` | `offerings` | SET NULL |
| `brand_assets.source_id` | `brand_sources` | SET NULL |
| `brand_sources.competitor_id` | `competitors` | CASCADE |
| `brand_chunks.source_id` | `brand_sources` | CASCADE |
| `content_plans.brand_bible_id` | `brand_bible` | RESTRICT |
| `plan_items.plan_id` | `content_plans` | CASCADE |
| `plan_items.pillar_id` | `content_pillars` | SET NULL |
| `plan_items.persona_id` | `personas` | SET NULL |
| `plan_items.reference_video_id` | `reference_videos` | SET NULL |
| `reference_videos.offering_id` | `offerings` | SET NULL |
| `reference_videos.media_id` | `media` | SET NULL |
| `plan_items.offering_id` | `offerings` | SET NULL |
| `plan_items.offer_id` | `offers` | SET NULL |
| `plan_items.selected_media_id` | `media` | SET NULL |
| `hook_library.plan_item_id` | `plan_items` | SET NULL |
| `media.plan_item_id` | `plan_items` | SET NULL |
| `media.offering_id` | `offerings` | SET NULL |
| `media.variant_of` | `media` | SET NULL |
| `media_files.media_id` | `media` | CASCADE |
| `posts.media_id` | `media` | RESTRICT |
| `posts.plan_item_id` | `plan_items` | SET NULL |
| `post_targets.post_id` | `posts` | CASCADE |
| `post_metrics.post_target_id` | `post_targets` | CASCADE |
| `feedback.plan_item_id` | `plan_items` | CASCADE |
| `feedback.media_id` | `media` | SET NULL |
| `agent_runs.plan_id` | `content_plans` | SET NULL |
| `agent_runs.plan_item_id` | `plan_items` | SET NULL |
| `agent_runs.media_id` | `media` | SET NULL |

## File storage (Cloudflare R2, bucket `brandwright-media`)

Files live in R2, not Supabase Storage (the schema makes no storage bucket). Public read by link (Kie, Zernio and Twelve Labs fetch files by URL). Only the server holds the R2 key: the browser uploads through a signed link made for a key in its own `<business id>/` folder; replacing and deleting is done by the server. Upload size limits are in `src/config/uploads.ts`.

| Key | What | Rows |
|---|---|---|
| `<business id>/brand/logo/<id>.png` | The logo | `business_profile.logo_key` |
| `<business id>/brand/logo/<id>-on-light.png`, `-on-dark.png` | Logo versions made by the Visual Identity Analyst | `brand_kit.logo_variants` |
| `<business id>/brand/photos/<asset id>.<ext>` | Products, people, place, work: uploads and photos from the website | `brand_assets` |
| `<business id>/brand/videos/<asset id>.<ext>` | The client's own videos | `brand_assets` |
| `<business id>/brand/references/<id>.<ext>` | Posts and ads the client likes; reference images for "Create an ad" | `brand_assets`, `media.reference_image_key` |
| `<business id>/media/<media id>/9x16.mp4`, `4x5.png`, `slide-01.png`… | Finished files of one media item: main size and renditions, slides. A redo adds `-r<round>` (a new name, so no cached copy of the old file shows) | `media.storage_key`, `media_files` (`rendition`, `slide`) |
| `work/<business id>/<media id>/…` | In-between files: AI pictures and clips (`scene-<n>-r<round>.png/.mp4`), reveal pictures, voice per scene, music. **Deleted by R2 after 90 days** | `media_files` (`thumbnail`, `voice`, `music`) |
| `tmp/…` | Upload-Post working files (`tmp/render-jobs/`) and test files (`tmp/smoke/`). **Deleted by R2 after 7 days** | none |
| `shared/fonts/<family>-<weight>.ttf` | Brand fonts from Google Fonts, kept for our renderers | none |
| `shared/sfx/<name>.wav` | Video sound effects (whoosh, swish, pop, ding, click, shutter, rise), put there by `scripts/setup/sfx.ts` | none |

Files uploaded by the browser are named by the id their row gets (`POST /api/uploads` returns `{ id, key, url }`). Build every key with the helpers in `src/providers/storage/paths.ts`. The auto-delete and CORS rules are set by `npm run smoke scripts/setup/r2-bucket.ts`.

## What's NOT stored

- **Connected accounts** — read live from the publishing provider, cached 60s
- **Captions on media** — written per post (or per plan item), because they differ by platform
- **File URLs** — built from storage keys by `publicUrl()` (`providers/storage/paths.ts`)
- **Job progress** — Inngest owns step state; `agent_runs` holds the human-readable summary and cost
