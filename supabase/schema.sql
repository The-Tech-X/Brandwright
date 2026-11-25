-- Brandwright: the whole database, in one file.
--
-- New, empty Supabase project: paste this file into the SQL Editor and run it once, before any login exists.
-- Then make the first admin with `npm run smoke scripts/setup/admin.ts <email>`.
--
-- This file is always the full, current database. To change the database:
--   1. edit this file where the thing lives (a column in its table, a rule in its section), so it still runs on
--      an empty project;
--   2. on a database that already exists, run just the change (alter table …, create or replace function …) in the
--      SQL Editor once;
--   3. update docs/database.md and regenerate src/types/database.ts.
--
-- Rules every business table follows (docs/database.md → Rules):
--   * business_id uuid not null, default current_business_id(), → businesses on delete cascade, with an index;
--   * a foreign key to another business table includes business_id, so a row never points at another business;
--   * RLS policy "own_business", trigger keep_business_id, and no anon access.
-- Settings tables (business_profile, app_settings, brand_kit) have one row per business, keyed by business_id.
-- Vector columns are 1536 wide (OpenAI text-embedding-3-small); a new model means changing them and re-embedding.

-- =====================================================================
-- 1. Extensions and default access
-- =====================================================================

create extension if not exists vector with schema extensions;

-- Logged-out visitors (anon) get nothing, now or on anything made later
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- =====================================================================
-- 2. Trigger helpers
-- =====================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- A row never moves to another business
create or replace function public.keep_business_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'A row cannot move to another business' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.keep_business_id() from public, anon, authenticated;

-- Columns only the server may set. Logged-in users can write their own rows straight through the API, so without
-- this they could point a post at another business's social account, cancel or read another business's posts,
-- swap in another Zernio profile or lift the safety cap. They may only clear these (null).
create or replace function public.guard_server_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
  new_value text;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  foreach col in array tg_argv loop
    new_value := to_jsonb(new) ->> col;
    if new_value is not null
       and (tg_op = 'INSERT' or new_value is distinct from (to_jsonb(old) ->> col)) then
      raise exception 'Only the server can set %.%', tg_table_name, col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.guard_server_columns() from public, anon, authenticated;

-- =====================================================================
-- 3. Businesses, who can open them, and admins
-- =====================================================================

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  -- The login that made it. Deleting the login keeps the business and its data
  owner_id uuid references auth.users (id) on delete set null,
  -- Files outside a business folder (from before businesses existed) may be deleted only by this business
  owns_unfoldered_files boolean not null default false,
  created_at timestamptz not null default now(),
  -- The credit balance, and a monthly fee that couldn't be taken (publishing waits until it is)
  credits integer not null default 0,
  fees_due jsonb,
  constraint businesses_credits_not_negative check (credits >= 0)
);

-- Which logins can open which business: 'owner' (made with it, or made it from "Add account") or 'member'
-- (linked by signing in once with that business's own login)
create table public.business_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);
create index idx_business_members_business_id on public.business_members (business_id);

-- Logins that see the admin panel (/admin) only. No business, no API access to this table
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The business a request is for, only when the login belongs to it (every RLS policy and column default uses it):
--   x-brandwright-business header: the business a browser tab shows (sent with every API call); not a member = none
--   x-brandwright-pick header: the business picked on this device (cookie, for page loads); not a member = ignored
--   neither: the login's own first business
-- Null for the service role: jobs and agents pass the business id themselves.
create or replace function public.current_business_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
  asked text := headers ->> 'x-brandwright-business';
  picked text := headers ->> 'x-brandwright-pick';
  found uuid;
begin
  if auth.uid() is null then
    return null;
  end if;
  -- A tab asks for the business it shows: that one when the login belongs to it, otherwise none (never another)
  if asked is not null then
    if asked !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return null;
    end if;
    select m.business_id into found from public.business_members m where m.user_id = auth.uid() and m.business_id = asked::uuid;
    return found;
  end if;
  -- A page load: the business picked on this device, while the login still belongs to it
  if picked ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select m.business_id into found from public.business_members m where m.user_id = auth.uid() and m.business_id = picked::uuid;
    if found is not null then
      return found;
    end if;
  end if;
  -- Otherwise the login's own first business
  select m.business_id into found from public.business_members m
  where m.user_id = auth.uid()
  order by (m.role = 'owner') desc, m.created_at
  limit 1;
  return found;
end;
$$;
revoke execute on function public.current_business_id() from public, anon;
grant execute on function public.current_business_id() to authenticated, service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- A new business gets its settings rows; notifications go to the owner's email by default
create or replace function public.seed_business()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.business_profile (business_id) values (new.id) on conflict do nothing;
  insert into public.app_settings (business_id, notify_email)
    values (new.id, (select email from auth.users where id = new.owner_id))
    on conflict do nothing;
  insert into public.brand_kit (business_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
revoke execute on function public.seed_business() from public, anon, authenticated;
create trigger seed_business after insert on public.businesses
  for each row execute function public.seed_business();

-- A new login gets its own business and is its owner; a login made with app_metadata.role = 'admin' becomes an
-- admin instead and gets none. Supabase's createUser can save the login before its app_metadata, so this may
-- not see the role: scripts/setup/admin.ts removes the business made for an admin that way
create or replace function public.create_business_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  made uuid;
begin
  if coalesce(new.raw_app_meta_data ->> 'role', '') = 'admin' then
    insert into public.admins (user_id) values (new.id) on conflict do nothing;
    return new;
  end if;
  if exists (select 1 from public.business_members where user_id = new.id) then
    return new;
  end if;
  insert into public.businesses (owner_id) values (new.id) returning id into made;
  insert into public.business_members (user_id, business_id, role) values (new.id, made, 'owner');
  return new;
end;
$$;
revoke execute on function public.create_business_for_new_user() from public, anon, authenticated;
create trigger brandwright_create_business after insert on auth.users
  for each row execute function public.create_business_for_new_user();

-- =====================================================================
-- 4. Settings (one row per business, made by seed_business)
-- =====================================================================

create table public.business_profile (
  business_id uuid primary key default public.current_business_id() references public.businesses (id) on delete cascade,
  name text not null default '',
  logo_key text,
  website text,
  language text not null default 'en',
  description text not null default '',
  business_type text check (business_type in ('product', 'service')),
  industry text,
  timezone text,
  countries text[] not null default '{}',
  cities text[] not null default '{}',
  -- Default currency for every price (each product keeps its own)
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  primary_goal text check (primary_goal in ('awareness', 'leads', 'sales', 'bookings', 'followers')),
  -- The one next step on every post; the link itself is in cta_links
  primary_cta text check (primary_cta is null or primary_cta in ('shop', 'whatsapp', 'book', 'call')),
  social_urls jsonb not null default '{}'::jsonb,
  cta_links jsonb not null default '{}'::jsonb,
  tone jsonb not null default '{}'::jsonb,
  compliance jsonb not null default '{"avoid_words": [], "forbidden_claims": [], "disclaimers": []}'::jsonb,
  posting_prefs jsonb not null default '{}'::jsonb,
  -- "Your content": goals (1–2, in order), images or videos, post styles in order, people, logo
  content_prefs jsonb not null default '{}'::jsonb,
  voice_id text,
  music_mood text,
  -- Onboarding answers, plus "scan" and "research" written by jobs (set_scan_state, set_research_state)
  onboarding jsonb not null default '{}'::jsonb,
  onboarding_status text not null default 'not_started'
    check (onboarding_status in ('not_started', 'collecting', 'analyzing', 'review', 'done')),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  business_id uuid primary key default public.current_business_id() references public.businesses (id) on delete cascade,
  -- Every post waits for the owner by default
  autopilot_mode text not null default 'approve_each' check (autopilot_mode in ('full', 'approve_plan', 'approve_each')),
  paused boolean not null default false,
  -- The Planner plans next week by itself on the plan day and time (off by default)
  auto_plan boolean not null default false,
  plan_weekday smallint not null default 0 check (plan_weekday between 0 and 6), -- 0 = Sunday
  plan_time time not null default '09:00',
  approval_timeout_hours integer not null default 24 check (approval_timeout_hours > 0),
  -- The monthly AI safety cap (server only)
  monthly_budget_usd numeric(10, 2) not null default 50 check (monthly_budget_usd >= 0),
  notify_email text,
  -- This business's own Zernio profile, made on first use (server only)
  zernio_profile_id text,
  updated_at timestamptz not null default now()
);

create table public.brand_kit (
  business_id uuid primary key default public.current_business_id() references public.businesses (id) on delete cascade,
  colors jsonb not null default '{}'::jsonb,        -- {primary, secondary, accent, bg, text}
  fonts jsonb not null default '{}'::jsonb,         -- {heading, body}
  logo_variants jsonb not null default '{}'::jsonb, -- storage keys: {full, mark, light, dark}
  photo_style text,
  layout_style text,
  -- What makes the website's look recognisable and how it moves (Visual Identity Analyst; editable)
  design_language text,
  template_ids text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- 5. Brand knowledge and the Brand Brain
-- =====================================================================

create table public.brand_bible (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  version integer not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  content jsonb not null default '{}'::jsonb, -- positioning, value_prop, tone_guide, visual_rules, offer_stack, do_dont, never_say
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint brand_bible_business_version_key unique (business_id, version),
  constraint brand_bible_id_business_key unique (id, business_id)
);
create index idx_brand_bible_business_id on public.brand_bible (business_id);
-- Only one approved Bible per business
create unique index brand_bible_one_approved on public.brand_bible (business_id) where status = 'approved';

create table public.personas (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  name text not null,
  summary text,
  pains text[] not null default '{}',
  desires text[] not null default '{}',
  objections text[] not null default '{}',
  triggers text[] not null default '{}',
  phrases text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personas_id_business_key unique (id, business_id)
);
create index idx_personas_business_id on public.personas (business_id);

create table public.content_pillars (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  name text not null,
  description text,
  target_share numeric(4, 3) not null default 0 check (target_share between 0 and 1),
  funnel_stage text check (funnel_stage in ('tofu', 'mofu', 'bofu')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_pillars_id_business_key unique (id, business_id)
);
create index idx_content_pillars_business_id on public.content_pillars (business_id);

-- Brands the client named or the Social & Market Analyst found: competitors, or inspiration to learn from
create table public.competitors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  name text not null,
  website text,
  social_urls jsonb not null default '{}'::jsonb,
  source text not null default 'client' check (source in ('client', 'discovered')),
  relation text not null default 'competitor' check (relation in ('competitor', 'inspiration')),
  analysis jsonb, -- {angles, offers, formats, gaps}
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint competitors_id_business_key unique (id, business_id)
);
create index idx_competitors_business_id on public.competitors (business_id);

-- Every page, post or file a fact was read from
create table public.brand_sources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('web_page', 'social_post', 'competitor', 'serp', 'review', 'upload', 'reference')),
  competitor_id uuid,
  url text,
  title text,
  content_md text,
  content_hash text, -- skip unchanged pages on refresh
  metadata jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  constraint brand_sources_id_business_key unique (id, business_id),
  constraint brand_sources_competitor_id_fkey foreign key (competitor_id, business_id)
    references public.competitors (id, business_id) on delete cascade
);
create index idx_brand_sources_business_id on public.brand_sources (business_id);
create index idx_brand_sources_competitor_id on public.brand_sources (competitor_id);
create index idx_brand_sources_url on public.brand_sources (url);

-- Products and services. Client-entered rows are verified; extracted ones stay active = false, verified = false
-- until the client confirms (confirm sets both true; reject keeps active = false, verified = true)
create table public.offerings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('product', 'service')),
  name text not null,
  description text,
  url text,
  price numeric(12, 2),
  currency text,
  price_model text check (price_model in ('fixed', 'from', 'hourly', 'quote', 'subscription')),
  benefits text[] not null default '{}',
  objections text[] not null default '{}',
  audience text,
  is_hero boolean not null default false,
  priority smallint not null default 0,
  attributes jsonb not null default '{}'::jsonb, -- product: variants, specs; service: process, turnaround, area
  source_id uuid,
  verified boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offerings_id_business_key unique (id, business_id),
  constraint offerings_source_id_fkey foreign key (source_id, business_id)
    references public.brand_sources (id, business_id) on delete set null (source_id)
);
create index idx_offerings_business_id on public.offerings (business_id);
create index idx_offerings_active on public.offerings (active, kind);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  offering_id uuid, -- null = store-wide deal
  title text not null,
  details text,
  code text,
  starts_at timestamptz,
  ends_at timestamptz,
  source_id uuid,
  verified boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint offers_id_business_key unique (id, business_id),
  constraint offers_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete cascade,
  constraint offers_source_id_fkey foreign key (source_id, business_id)
    references public.brand_sources (id, business_id) on delete set null (source_id)
);
create index idx_offers_business_id on public.offers (business_id);
create index idx_offers_offering_id on public.offers (offering_id);
create index idx_offers_ends_at on public.offers (ends_at) where active;

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  date date not null,
  name text not null,
  kind text not null check (kind in ('holiday', 'sale', 'launch', 'trend')),
  relevance smallint not null default 3 check (relevance between 1 and 5),
  source text not null check (source in ('system', 'client', 'serp')),
  notes text,
  created_at timestamptz not null default now()
);
create index idx_calendar_events_business_id on public.calendar_events (business_id);
create index idx_calendar_events_date on public.calendar_events (date);

-- Passages of the Brand Brain, searched exactly within one business (match_brand_chunks; no shared vector index)
create table public.brand_chunks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  source_id uuid not null,
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb, -- {offering_id, kind} for filtered search
  created_at timestamptz not null default now(),
  constraint brand_chunks_source_id_fkey foreign key (source_id, business_id)
    references public.brand_sources (id, business_id) on delete cascade
);
create index idx_brand_chunks_business_id on public.brand_chunks (business_id);
create index idx_brand_chunks_source_id on public.brand_chunks (source_id);
create index idx_brand_chunks_metadata on public.brand_chunks using gin (metadata);

create table public.proof_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  offering_id uuid, -- null = about the whole business
  source_id uuid,
  kind text not null check (kind in ('review', 'testimonial', 'case_study', 'stat', 'award', 'certification')),
  content text not null,
  author text,
  rating numeric(2, 1) check (rating between 0 and 5),
  verified boolean not null default false, -- client-confirmed or from a real source
  created_at timestamptz not null default now(),
  constraint proof_items_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete set null (offering_id),
  constraint proof_items_source_id_fkey foreign key (source_id, business_id)
    references public.brand_sources (id, business_id) on delete set null (source_id)
);
create index idx_proof_items_business_id on public.proof_items (business_id);
create index idx_proof_items_offering_id on public.proof_items (offering_id);
create index idx_proof_items_source_id on public.proof_items (source_id);

-- The client's photos and videos (person: people who appear in posts; reference_image: posts and ads they like;
-- general: not tied to a product)
create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  offering_id uuid,
  -- The website page a photo was found on
  source_id uuid,
  kind text not null check (
    kind in ('product_photo', 'team', 'location', 'work', 'reference_video', 'doc', 'person', 'reference_image', 'general')
  ),
  storage_key text not null, -- never a URL
  ai_description text,
  -- What a video shows, from one read by the video watcher: {duration, summary, moments: [...]}; null for photos and
  -- videos not watched yet
  analysis jsonb,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint brand_assets_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete set null (offering_id),
  constraint brand_assets_source_id_fkey foreign key (source_id, business_id)
    references public.brand_sources (id, business_id) on delete set null (source_id)
);
create index idx_brand_assets_business_id on public.brand_assets (business_id);
create index idx_brand_assets_offering_id on public.brand_assets (offering_id);
create index idx_brand_assets_source_id on public.brand_assets (source_id);
create unique index brand_assets_id_business_id_uidx on public.brand_assets (id, business_id);
-- Videos still to watch, per business
create index idx_brand_assets_unwatched on public.brand_assets (business_id) where analysis is null;

-- =====================================================================
-- 6. Planning and creative
-- =====================================================================

create table public.content_plans (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  week_start date not null,
  brand_bible_id uuid,
  status text not null default 'planning'
    check (status in ('planning', 'producing', 'review', 'approved', 'scheduled', 'done', 'failed')),
  strategy jsonb not null default '{}'::jsonb, -- {theme, mix, rationale}
  -- When full autopilot approves by itself, and the plain reason a plan failed
  approval_due_at timestamptz,
  error text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint content_plans_business_week_key unique (business_id, week_start),
  constraint content_plans_id_business_key unique (id, business_id),
  -- NO ACTION, not RESTRICT: deleting a whole business removes both sides in one statement
  constraint content_plans_brand_bible_id_fkey foreign key (brand_bible_id, business_id)
    references public.brand_bible (id, business_id)
);
create index idx_content_plans_business_id on public.content_plans (business_id);

-- One post slot. Its foreign keys to media and reference_videos are added after those tables (section 7)
create table public.plan_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  plan_id uuid not null,
  slot_at timestamptz not null,
  platforms text[] not null default '{}',
  format text not null check (format in ('static', 'carousel', 'video', 'text')),
  -- The client's image or video style for this post (e.g. "tips", "showcase"), picked by the Planner's code
  style text,
  pillar_id uuid,
  persona_id uuid,
  offering_id uuid,
  offer_id uuid,
  funnel_stage text,
  objective text,
  -- The Planner's strategy: what the post is for (code), the one desire it taps and the audience's awareness (AI)
  ad_objective text check (ad_objective in ('awareness', 'converting', 'retargeting')),
  desire text check (desire in ('health', 'attraction', 'status', 'belonging', 'control', 'comfort')),
  awareness_level text check (awareness_level in ('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware')),
  angle text,
  framework text,
  hook_type text,
  hook_text text,
  levers text[] not null default '{}',
  is_experiment boolean not null default false,
  -- "Copy a video" (reference_videos) and an ad the owner likes for an image ad (a tmp/ key, gone after 7 days)
  reference_video_id uuid,
  reference_image_key text,
  -- Videos made by hand: the resolution the owner picked; null = the default (config/video-direct.ts, 480p)
  video_resolution text check (video_resolution is null or video_resolution in ('480p', '720p')),
  brief jsonb,
  captions jsonb, -- {platform: text}
  rationale text,
  brief_score numeric(4, 2),
  qa_score numeric(4, 2),
  qa_report jsonb,
  attempts smallint not null default 0 check (attempts between 0 and 3),
  -- ready = passed both QA gates and waits for the client; needs_review = QA still failed after two redos
  status text not null default 'planned' check (
    status in ('planned', 'briefed', 'producing', 'qa', 'ready', 'needs_review', 'approved', 'rejected', 'scheduled', 'published', 'failed')
  ),
  selected_media_id uuid,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_items_id_business_key unique (id, business_id),
  constraint plan_items_plan_id_fkey foreign key (plan_id, business_id)
    references public.content_plans (id, business_id) on delete cascade,
  constraint plan_items_pillar_id_fkey foreign key (pillar_id, business_id)
    references public.content_pillars (id, business_id) on delete set null (pillar_id),
  constraint plan_items_persona_id_fkey foreign key (persona_id, business_id)
    references public.personas (id, business_id) on delete set null (persona_id),
  constraint plan_items_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete set null (offering_id),
  constraint plan_items_offer_id_fkey foreign key (offer_id, business_id)
    references public.offers (id, business_id) on delete set null (offer_id)
);
create index idx_plan_items_business_id on public.plan_items (business_id);
create index idx_plan_items_plan_id on public.plan_items (plan_id, slot_at);
create index idx_plan_items_status on public.plan_items (status);
create index idx_plan_items_pillar_id on public.plan_items (pillar_id);
create index idx_plan_items_persona_id on public.plan_items (persona_id);
create index idx_plan_items_offering_id on public.plan_items (offering_id);
create index idx_plan_items_offer_id on public.plan_items (offer_id);
create index idx_plan_items_selected_media_id on public.plan_items (selected_media_id);
create index idx_plan_items_reference_video_id on public.plan_items (reference_video_id);

-- Hooks, so the Creative Director avoids repeating recent ones (match_recent_hooks)
create table public.hook_library (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  text text not null,
  hook_type text,
  platform text,
  source text not null check (source in ('generated', 'own_winner', 'competitor', 'reference')),
  plan_item_id uuid,
  score numeric, -- performance vs. baseline (1.0 = average)
  uses integer not null default 0,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  constraint hook_library_plan_item_id_fkey foreign key (plan_item_id, business_id)
    references public.plan_items (id, business_id) on delete set null (plan_item_id)
);
create index idx_hook_library_business_id on public.hook_library (business_id);
create index idx_hook_library_plan_item_id on public.hook_library (plan_item_id);

-- =====================================================================
-- 7. Media
-- =====================================================================

-- Every image, video, carousel or text made or uploaded, with all its generation inputs (so "Try again" works)
create table public.media (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  type text not null check (type in ('image', 'video', 'text', 'carousel')),
  source text not null check (source in ('generated', 'uploaded')),
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  plan_item_id uuid,
  offering_id uuid,
  variant_of uuid,
  idea text,
  aspect_ratio text check (aspect_ratio in ('1:1', '4:5', '9:16', '16:9')),
  use_logo boolean,
  duration_sec integer check (duration_sec in (15, 30, 45, 60)),
  content text,
  voice_id text,
  voice_name text,
  audio_style text,
  "character" text,
  language text,
  reference_image_key text,
  creative_spec jsonb,
  video_analysis jsonb,
  storage_key text,
  cost_usd numeric(10, 4) not null default 0,
  error text,
  created_at timestamptz not null default now(),
  constraint media_id_business_key unique (id, business_id),
  constraint media_plan_item_id_fkey foreign key (plan_item_id, business_id)
    references public.plan_items (id, business_id) on delete set null (plan_item_id),
  constraint media_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete set null (offering_id),
  constraint media_variant_of_fkey foreign key (variant_of, business_id)
    references public.media (id, business_id) on delete set null (variant_of)
);
create index idx_media_business_id on public.media (business_id);
create index idx_media_type on public.media (type);
create index idx_media_status on public.media (status);
create index idx_media_created_at on public.media (created_at desc);
create index idx_media_plan_item_id on public.media (plan_item_id);
create index idx_media_offering_id on public.media (offering_id);
create index idx_media_variant_of on public.media (variant_of);

-- A media item's files: carousel slides, renditions per size, thumbnails, voice, music, subtitles
create table public.media_files (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  media_id uuid not null,
  role text not null check (role in ('slide', 'rendition', 'thumbnail', 'voice', 'music', 'subtitles')),
  position smallint not null default 0,
  aspect_ratio text,
  storage_key text not null,
  created_at timestamptz not null default now(),
  constraint media_files_media_id_fkey foreign key (media_id, business_id)
    references public.media (id, business_id) on delete cascade
);
create index idx_media_files_business_id on public.media_files (business_id);
create index idx_media_files_media_id on public.media_files (media_id, role, position);

-- Videos the owner chose to copy ("Copy a video"): the breakdown is kept for good; the file only while it's read
create table public.reference_videos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  -- An upload, or a pasted link (Meta Ad Library, Instagram, TikTok, YouTube, Facebook or a video file)
  source text not null check (source in ('upload', 'link')),
  source_url text,
  platform text check (platform in ('meta_ad', 'instagram', 'tiktok', 'youtube', 'facebook', 'other')),
  -- What the link's page said about the video: caption or ad text, account, views, likes, comments, shares, saves
  source_meta jsonb not null default '{}'::jsonb,
  offering_id uuid,
  -- The latest video made from it
  media_id uuid,
  -- The file while it's read (tmp/, deleted by storage after 7 days)
  storage_key text,
  -- The scene-by-scene breakdown (prompts/agents/reference-video.ts), its summary and length
  analysis jsonb,
  summary text,
  duration_sec numeric,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reference_videos_id_business_key unique (id, business_id),
  constraint reference_videos_offering_id_fkey foreign key (offering_id, business_id)
    references public.offerings (id, business_id) on delete set null (offering_id),
  constraint reference_videos_media_id_fkey foreign key (media_id, business_id)
    references public.media (id, business_id) on delete set null (media_id)
);
create index idx_reference_videos_business_id on public.reference_videos (business_id);
create index idx_reference_videos_offering_id on public.reference_videos (offering_id);
create index idx_reference_videos_media_id on public.reference_videos (media_id);

-- plan_items' links to tables made after it
alter table public.plan_items
  add constraint plan_items_selected_media_id_fkey foreign key (selected_media_id, business_id)
    references public.media (id, business_id) on delete set null (selected_media_id),
  add constraint plan_items_reference_video_id_fkey foreign key (reference_video_id, business_id)
    references public.reference_videos (id, business_id) on delete set null (reference_video_id);

-- =====================================================================
-- 8. Publishing and performance
-- =====================================================================

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  media_id uuid not null,
  plan_item_id uuid unique,
  origin text not null default 'manual' check (origin in ('manual', 'agent')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed')),
  publish_at timestamptz,
  created_at timestamptz not null default now(),
  constraint posts_id_business_key unique (id, business_id),
  -- Matches the foreign key's columns, so the API embeds a slot's post as one object, not a list
  constraint posts_plan_item_business_key unique (plan_item_id, business_id),
  -- Media used by a post can't be deleted (NO ACTION)
  constraint posts_media_id_fkey foreign key (media_id, business_id)
    references public.media (id, business_id),
  constraint posts_plan_item_id_fkey foreign key (plan_item_id, business_id)
    references public.plan_items (id, business_id) on delete set null (plan_item_id)
);
create index idx_posts_business_id on public.posts (business_id);
create index idx_posts_status on public.posts (status);
create index idx_posts_publish_at on public.posts (publish_at);
create index idx_posts_created_at on public.posts (created_at desc);

-- One post on one account. account_name is copied at post time for history
create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  post_id uuid not null,
  platform text not null,
  account_id text not null,
  account_name text not null,
  caption text not null default '',
  provider text not null default 'zernio',
  status text not null default 'pending' check (status in ('pending', 'sending', 'published', 'failed')),
  -- Server only (guard_server_columns)
  provider_ref text,
  provider_post_id text,
  url text,
  error text,
  published_at timestamptz,
  unique (post_id, platform, account_id),
  constraint post_targets_id_business_key unique (id, business_id),
  constraint post_targets_post_id_fkey foreign key (post_id, business_id)
    references public.posts (id, business_id) on delete cascade
);
create index idx_post_targets_business_id on public.post_targets (business_id);
create index idx_post_targets_post_id on public.post_targets (post_id);

create table public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  post_target_id uuid not null,
  captured_on date not null,
  impressions integer,
  reach integer,
  views integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  clicks integer,
  followers_gained integer,
  avg_watch_sec numeric,
  completion_rate numeric,
  engagement_rate numeric,
  raw jsonb,
  unique (post_target_id, captured_on),
  constraint post_metrics_post_target_id_fkey foreign key (post_target_id, business_id)
    references public.post_targets (id, business_id) on delete cascade
);
create index idx_post_metrics_business_id on public.post_metrics (business_id);

create table public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  platform text not null,
  account_id text not null,
  captured_on date not null,
  followers integer,
  raw jsonb,
  constraint account_snapshots_business_account_day_key unique (business_id, platform, account_id, captured_on)
);
create index idx_account_snapshots_business_id on public.account_snapshots (business_id);

-- What the Performance Analyst learned, per dimension and value; 'baseline' rows hold each platform's median
create table public.learnings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  dimension text not null check (dimension in (
    'baseline', 'angle', 'hook_type', 'format', 'framework', 'lever', 'pillar', 'persona', 'time_slot', 'style',
    'ad_objective', 'desire', 'awareness_level', 'style_modifier'
  )),
  value text not null, -- name, or id as text for pillar/persona (no FK on purpose)
  platform text,       -- null = all platforms
  sample_size integer not null default 0,
  score numeric,       -- vs. the account's baseline (1.0 = average)
  confidence numeric,
  insight text,
  updated_at timestamptz not null default now(),
  constraint learnings_business_dimension_value_platform_key unique nulls not distinct (business_id, dimension, value, platform)
);
create index idx_learnings_business_id on public.learnings (business_id);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  plan_item_id uuid not null,
  media_id uuid,
  action text not null check (action in ('approve', 'reject', 'edit', 'regenerate')),
  note text,
  created_at timestamptz not null default now(),
  constraint feedback_plan_item_id_fkey foreign key (plan_item_id, business_id)
    references public.plan_items (id, business_id) on delete cascade,
  constraint feedback_media_id_fkey foreign key (media_id, business_id)
    references public.media (id, business_id) on delete set null (media_id)
);
create index idx_feedback_business_id on public.feedback (business_id);
create index idx_feedback_plan_item_id on public.feedback (plan_item_id);
create index idx_feedback_media_id on public.feedback (media_id);

-- The Performance Analyst's weekly report: one per week, shown on Performance and emailed
create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  week_start date not null, -- Monday of the week the report covers
  headline text not null,
  summary text not null,
  next_week text[] not null default '{}',
  stats jsonb not null default '{}'::jsonb, -- {posts, reach, engagements, er, prevEr, bestPostId, followers}
  created_at timestamptz not null default now(),
  constraint weekly_reports_business_week_key unique (business_id, week_start)
);
create index idx_weekly_reports_business_id on public.weekly_reports (business_id);

-- =====================================================================
-- 9. System
-- =====================================================================

-- Every agent step: summary, tokens, cost and time. run_id groups the steps of one run
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  agent text not null, -- website_analyst, planner, producer…
  run_id text,
  plan_id uuid,
  plan_item_id uuid,
  media_id uuid,
  inngest_run_id text,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  summary text,
  input jsonb,
  output jsonb,
  model text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 4) not null default 0,
  duration_ms integer,
  error text,
  created_at timestamptz not null default now(),
  constraint agent_runs_plan_id_fkey foreign key (plan_id, business_id)
    references public.content_plans (id, business_id) on delete set null (plan_id),
  constraint agent_runs_plan_item_id_fkey foreign key (plan_item_id, business_id)
    references public.plan_items (id, business_id) on delete set null (plan_item_id),
  constraint agent_runs_media_id_fkey foreign key (media_id, business_id)
    references public.media (id, business_id) on delete set null (media_id)
);
create index idx_agent_runs_business_id on public.agent_runs (business_id);
create index idx_agent_runs_business_created on public.agent_runs (business_id, created_at); -- month_spend
create index idx_agent_runs_created_at on public.agent_runs (created_at desc);
create index idx_agent_runs_created on public.agent_runs (created_at);
create index idx_agent_runs_plan_id on public.agent_runs (plan_id);
create index idx_agent_runs_plan_item_id on public.agent_runs (plan_item_id);
create index idx_agent_runs_media_id on public.agent_runs (media_id);
create index idx_agent_runs_inngest_run_id on public.agent_runs (inngest_run_id);
create index agent_runs_run_id on public.agent_runs (run_id, created_at);

-- In-app notifications; each can also go out by email (rows are 'skipped' until EMAIL_ENABLED is set)
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  email_status text not null default 'none' check (email_status in ('none', 'pending', 'sent', 'skipped', 'failed')),
  email_to text,
  email_error text,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_notifications_business_id on public.notifications (business_id);
create index idx_notifications_unread on public.notifications (created_at desc) where read_at is null;

-- Meta Ad Library pages a business fetched, kept 48 hours (the app deletes older rows when it saves a new page).
-- The same search is read from here, and the day's rows count the business's live calls for its daily limit
create table public.ad_library_searches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
  -- 'keyword' (ads whose words match) or 'brand' (one advertiser's ads)
  kind text not null check (kind in ('keyword', 'brand')),
  -- What was searched, lower-cased and trimmed
  query text not null,
  -- ISO 3166-1 code, or 'ALL'
  country text not null,
  page integer not null check (page >= 1),
  -- The page's video ads (id, brand, text, video and preview links, start date, platforms)
  ads jsonb not null default '[]'::jsonb,
  -- Where the next page starts; null on the last page
  next_cursor text,
  fetched_at timestamptz not null default now(),
  constraint ad_library_searches_page_key unique (business_id, kind, query, country, page)
);
create index idx_ad_library_searches_business_fetched on public.ad_library_searches (business_id, fetched_at);

-- =====================================================================
-- 10. Credits
-- =====================================================================

-- What each action costs. Read by every login (the app shows prices); changed only by the server (admin panel)
create table public.credit_prices (
  action text primary key,
  credits integer not null check (credits >= 0),
  label text not null,
  sort integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.credit_prices (action, credits, label, sort) values
  ('onboarding', 15, 'Onboarding (website scan and brand research)', 10),
  ('brand_refresh', 10, 'Refresh brand', 20),
  ('market_refresh', 5, 'Monthly market refresh', 30),
  ('bible_regenerate', 2, 'Rewrite the Brand Bible', 40),
  ('brand_video', 1, 'Video added to brand assets', 50),
  ('week_plan', 2, 'Plan a week', 60),
  ('image_ad', 8, 'Image ad', 70),
  ('image_ad_reference', 10, 'Image ad from a reference image', 80),
  ('carousel', 8, 'Carousel', 90),
  ('text_post', 2, 'Text post', 100),
  ('video', 70, 'Video (up to 30 seconds)', 110),
  ('video_copy', 70, 'Copy a video', 120),
  ('video_720p', 140, 'Video in 720p (up to 30 seconds)', 124),
  ('video_copy_720p', 140, 'Copy a video in 720p', 126),
  ('social_account', 60, 'Social account (per month)', 130)
on conflict (action) do nothing;

-- Every change to a balance: 'topup' (an admin added credits), 'adjust' (an admin took some away), 'charge' (an
-- action used them), 'refund' (a charge given back when the work failed). Written only by the credit_* functions
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('topup', 'adjust', 'charge', 'refund')),
  -- Added (+) or taken (-)
  credits integer not null,
  -- The balance after this row
  balance integer not null check (balance >= 0),
  -- What it was for (credit_prices.action); null for top-ups and adjustments
  action text,
  -- What the client sees: "Image ad · Summer sale"
  label text not null default '',
  -- The slot, plan, media item, research run or asset it was for
  ref_id uuid,
  -- What the client paid for a top-up (optional, US dollars)
  amount_usd numeric(10, 2) check (amount_usd is null or amount_usd >= 0),
  note text,
  -- The same key is charged once (retries can't charge twice)
  key text,
  -- A refund names the charge it gives back (once)
  refund_of uuid references public.credit_ledger (id) on delete set null,
  -- The admin who added or removed credits
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index credit_ledger_key on public.credit_ledger (business_id, key) where key is not null;
create unique index credit_ledger_refund_of on public.credit_ledger (refund_of) where refund_of is not null;
create index idx_credit_ledger_business_created on public.credit_ledger (business_id, created_at desc);
create index idx_credit_ledger_created on public.credit_ledger (created_at);

-- =====================================================================
-- 11. Triggers on business tables
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'business_profile', 'app_settings', 'brand_kit', 'personas', 'content_pillars',
    'offerings', 'offers', 'plan_items', 'learnings'
  ] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;

  foreach t in array array[
    'business_profile', 'app_settings', 'brand_kit',
    'brand_bible', 'personas', 'content_pillars', 'offerings', 'offers', 'competitors', 'calendar_events',
    'brand_sources', 'brand_chunks', 'proof_items', 'brand_assets',
    'content_plans', 'plan_items', 'hook_library',
    'media', 'media_files', 'reference_videos', 'posts', 'post_targets', 'post_metrics', 'account_snapshots',
    'learnings', 'feedback', 'weekly_reports', 'agent_runs', 'notifications', 'ad_library_searches', 'credit_ledger'
  ] loop
    execute format(
      'create trigger keep_business_id before update of business_id on public.%I for each row execute function public.keep_business_id()',
      t
    );
  end loop;
end;
$$;

create trigger guard_server_columns before insert or update on public.app_settings
  for each row execute function public.guard_server_columns('zernio_profile_id', 'monthly_budget_usd');
create trigger guard_server_columns before insert or update on public.post_targets
  for each row execute function public.guard_server_columns('provider_ref', 'provider_post_id');

-- =====================================================================
-- 12. Access: RLS and grants
-- =====================================================================

-- Each login sees and writes only the business it is working in
do $$
declare t text;
begin
  foreach t in array array[
    'business_profile', 'app_settings', 'brand_kit',
    'brand_bible', 'personas', 'content_pillars', 'offerings', 'offers', 'competitors', 'calendar_events',
    'brand_sources', 'brand_chunks', 'proof_items', 'brand_assets',
    'content_plans', 'plan_items', 'hook_library',
    'media', 'media_files', 'reference_videos', 'posts', 'post_targets', 'post_metrics', 'account_snapshots',
    'learnings', 'feedback', 'weekly_reports', 'agent_runs', 'notifications', 'ad_library_searches'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "own_business" on public.%I for all to authenticated using (business_id = (select public.current_business_id())) with check (business_id = (select public.current_business_id()))',
      t
    );
  end loop;
end;
$$;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant all privileges on all tables in schema public to authenticated, service_role;
grant all privileges on all sequences in schema public to authenticated, service_role;

-- A login reads the businesses it belongs to (changes go through functions and the server)
alter table public.businesses enable row level security;
create policy "member_reads" on public.businesses for select to authenticated
  using (exists (select 1 from public.business_members m where m.business_id = id and m.user_id = (select auth.uid())));
revoke all on public.businesses from anon, authenticated;
grant select on public.businesses to authenticated;
grant all on public.businesses to service_role;

alter table public.business_members enable row level security;
create policy "own_memberships" on public.business_members for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.business_members from anon, authenticated;
grant select on public.business_members to authenticated;
grant all on public.business_members to service_role;

-- No policies: only the server (service role) and is_admin() read it
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
grant all on public.admins to service_role;

alter table public.credit_prices enable row level security;
create policy "everyone_reads" on public.credit_prices for select to authenticated using (true);
revoke all on public.credit_prices from anon, authenticated;
grant select on public.credit_prices to authenticated;
grant all on public.credit_prices to service_role;

-- A business reads its own rows, without the admins' note, who added them and the charge keys; nobody writes them
-- through the API
alter table public.credit_ledger enable row level security;
create policy "own_business" on public.credit_ledger for select to authenticated
  using (business_id = (select public.current_business_id()));
revoke all on public.credit_ledger from anon, authenticated;
grant select (id, business_id, kind, credits, balance, action, label, ref_id, amount_usd, refund_of, created_at) on public.credit_ledger to authenticated;
grant all on public.credit_ledger to service_role;

-- =====================================================================
-- 13. Search (exact, within one business)
-- =====================================================================
-- Logged-in callers search their own business (RLS applies as well); the service role passes p_business_id, and
-- without it nothing matches. "materialized" keeps the search to the business's own rows, so it is always complete.

create or replace function public.match_brand_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  filter jsonb default '{}'::jsonb,
  p_business_id uuid default null
)
returns table (id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  with own as materialized (
    select c.id, c.source_id, c.content, c.metadata, c.embedding
    from brand_chunks c
    where c.business_id = coalesce(p_business_id, public.current_business_id())
      and c.embedding is not null
      and c.metadata @> filter
  )
  select own.id, own.source_id, own.content, own.metadata, 1 - (own.embedding <=> query_embedding) as similarity
  from own
  order by own.embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function public.match_brand_chunks(extensions.vector, integer, jsonb, uuid) from public, anon;
grant execute on function public.match_brand_chunks(extensions.vector, integer, jsonb, uuid) to authenticated, service_role;

-- Hooks too close to recent ones are rejected by the Creative Director
create or replace function public.match_recent_hooks(
  query_embedding extensions.vector(1536),
  since timestamptz,
  match_count integer default 5,
  p_business_id uuid default null
)
returns table (id uuid, text text, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  with own as materialized (
    select h.id, h.text, h.embedding
    from hook_library h
    where h.business_id = coalesce(p_business_id, public.current_business_id())
      and h.embedding is not null
      and (h.created_at >= since or h.plan_item_id is not null)
  )
  select own.id, own.text, 1 - (own.embedding <=> query_embedding) as similarity
  from own
  order by own.embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function public.match_recent_hooks(extensions.vector, timestamptz, integer, uuid) from public, anon;
grant execute on function public.match_recent_hooks(extensions.vector, timestamptz, integer, uuid) to authenticated, service_role;

-- =====================================================================
-- 14. Onboarding state
-- =====================================================================
-- Jobs write onboarding.research.<path> and onboarding.scan.<path> while the client saves steps, so each write is
-- one atomic statement with no read first and never overwrites the other side's keys.

-- Parent keys must exist (submit creates research.agents)
create or replace function public.set_research_state(path text[], value jsonb, p_business_id uuid)
returns void
language sql
set search_path = public
as $$
  update business_profile
  set onboarding = jsonb_set(coalesce(onboarding, '{}'::jsonb), array['research'] || path, value, true)
  where business_id = p_business_id;
$$;
revoke execute on function public.set_research_state(text[], jsonb, uuid) from public, anon, authenticated;
grant execute on function public.set_research_state(text[], jsonb, uuid) to service_role;

create or replace function public.set_scan_state(path text[], value jsonb, p_business_id uuid)
returns void
language sql
set search_path = public
as $$
  update business_profile
  set onboarding = jsonb_set(
    case when coalesce(onboarding, '{}'::jsonb) ? 'scan' then onboarding else coalesce(onboarding, '{}'::jsonb) || '{"scan": {}}'::jsonb end,
    array['scan'] || path, value, true
  )
  where business_id = p_business_id;
$$;
revoke execute on function public.set_scan_state(text[], jsonb, uuid) from public, anon, authenticated;
grant execute on function public.set_scan_state(text[], jsonb, uuid) to service_role;

-- Merges answers into the onboarding JSON without touching keys the request didn't send
create or replace function public.merge_onboarding(patch jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  update business_profile
  set onboarding = coalesce(onboarding, '{}'::jsonb) || patch
  where business_id = public.current_business_id();
$$;
revoke execute on function public.merge_onboarding(jsonb) from public, anon;
grant execute on function public.merge_onboarding(jsonb) to authenticated;

-- =====================================================================
-- 15. Account menu
-- =====================================================================

-- The login's businesses: name, logo, how far its setup is, and how it was added
create or replace function public.my_businesses()
returns table (id uuid, name text, logo_key text, onboarding_status text, role text, added_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id, coalesce(p.name, ''), p.logo_key, coalesce(p.onboarding_status, 'not_started'), m.role, m.created_at
  from public.business_members m
  left join public.business_profile p on p.business_id = m.business_id
  where m.user_id = auth.uid()
  order by m.created_at
$$;
revoke execute on function public.my_businesses() from public, anon;
grant execute on function public.my_businesses() to authenticated;

-- "Add account" → a new business: the login's unfinished setup when it has one (one at a time), else a new business
-- it owns (its settings rows come from seed_business). At most 25 businesses per login
create or replace function public.create_business()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  made uuid;
begin
  if me is null then
    raise exception 'Log in to add a business';
  end if;
  select m.business_id into made
  from public.business_members m
  join public.business_profile p on p.business_id = m.business_id
  where m.user_id = me and m.role = 'owner' and p.onboarding_status <> 'done'
  order by m.created_at desc
  limit 1;
  if made is not null then
    return made;
  end if;
  if (select count(*) from public.business_members where user_id = me) >= 25 then
    raise exception 'You already have 25 businesses on this login';
  end if;
  insert into public.businesses (owner_id) values (me) returning id into made;
  insert into public.business_members (user_id, business_id, role) values (me, made, 'owner');
  return made;
end;
$$;
revoke execute on function public.create_business() from public, anon;
grant execute on function public.create_business() to authenticated;

-- The login email of the business a request is for (its owner's), so the menu shows the open business's email
create or replace function public.business_login_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email
  from public.businesses b
  join auth.users u on u.id = b.owner_id
  where b.id = public.current_business_id()
$$;
revoke execute on function public.business_login_email() from public, anon;
grant execute on function public.business_login_email() to authenticated;

-- =====================================================================
-- 16. Spend and credits
-- =====================================================================

-- This month's agent spend, added up here (reading the rows stopped at the API's 1,000-row cap). Drives the cap
create or replace function public.month_spend(p_since timestamptz, p_business_id uuid default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(r.cost_usd), 0)
  from public.agent_runs r
  where r.business_id = coalesce(p_business_id, public.current_business_id())
    and r.created_at >= p_since
$$;
revoke execute on function public.month_spend(timestamptz, uuid) from public, anon;
grant execute on function public.month_spend(timestamptz, uuid) to authenticated, service_role;

-- The balance (and any fee due): the logged-in business, or the one a job passes. Security invoker: RLS on
-- businesses lets a login read only its own
create or replace function public.credit_balance(p_business_id uuid default null)
returns table (credits integer, fees_due jsonb)
language sql
stable
set search_path = ''
as $$
  select b.credits, b.fees_due from public.businesses b
  where b.id = coalesce(p_business_id, public.current_business_id())
$$;
revoke execute on function public.credit_balance(uuid) from public, anon;
grant execute on function public.credit_balance(uuid) to authenticated, service_role;

-- Takes credits for an action, locking the business row so two actions never spend the same credits. Not enough:
-- raises NO_CREDITS (with what's needed and what's there) and takes nothing. A key already used returns the balance
-- without charging again. Returns the new balance
create or replace function public.credit_spend(
  p_business_id uuid,
  p_credits integer,
  p_action text,
  p_label text,
  p_ref_id uuid default null,
  p_key text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  have integer;
begin
  if p_credits is null or p_credits < 0 then
    raise exception 'Credits to take must be 0 or more';
  end if;
  select b.credits into have from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'No such business';
  end if;
  if p_key is not null and exists (select 1 from public.credit_ledger l where l.business_id = p_business_id and l.key = p_key) then
    return have;
  end if;
  if p_credits = 0 then
    return have;
  end if;
  if have < p_credits then
    raise exception 'NO_CREDITS needed=% have=%', p_credits, have using errcode = 'P0001';
  end if;
  update public.businesses set credits = have - p_credits where id = p_business_id;
  insert into public.credit_ledger (business_id, kind, credits, balance, action, label, ref_id, key)
  values (p_business_id, 'charge', -p_credits, have - p_credits, p_action, coalesce(p_label, ''), p_ref_id, p_key);
  return have - p_credits;
end;
$$;
revoke execute on function public.credit_spend(uuid, integer, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.credit_spend(uuid, integer, text, text, uuid, text) to service_role;

-- Gives back the charge made with this key (once). No such charge: nothing happens. Returns the balance
create or replace function public.credit_refund(p_business_id uuid, p_key text, p_label text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.credit_ledger;
  have integer;
begin
  select * into c from public.credit_ledger l where l.business_id = p_business_id and l.key = p_key and l.kind = 'charge';
  select b.credits into have from public.businesses b where b.id = p_business_id for update;
  if c.id is null or exists (select 1 from public.credit_ledger l where l.refund_of = c.id) then
    return have;
  end if;
  update public.businesses set credits = have - c.credits where id = p_business_id;
  insert into public.credit_ledger (business_id, kind, credits, balance, action, label, ref_id, refund_of, key)
  values (p_business_id, 'refund', -c.credits, have - c.credits, c.action, coalesce(p_label, 'Returned: ' || c.label), c.ref_id, c.id, 'refund:' || p_key);
  return have - c.credits;
end;
$$;
revoke execute on function public.credit_refund(uuid, text, text) from public, anon, authenticated;
grant execute on function public.credit_refund(uuid, text, text) to service_role;

-- An admin adds credits (with what the client paid, when given) or takes some away (never below 0)
create or replace function public.credit_topup(
  p_business_id uuid,
  p_credits integer,
  p_amount_usd numeric default null,
  p_note text default null,
  p_admin uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  have integer;
begin
  if p_credits is null or p_credits = 0 then
    raise exception 'Enter a number of credits other than 0';
  end if;
  select b.credits into have from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'No such business';
  end if;
  if have + p_credits < 0 then
    raise exception 'This business has only % credits to take away', have;
  end if;
  update public.businesses set credits = have + p_credits where id = p_business_id;
  insert into public.credit_ledger (business_id, kind, credits, balance, label, amount_usd, note, created_by)
  values (
    p_business_id,
    case when p_credits > 0 then 'topup' else 'adjust' end,
    p_credits,
    have + p_credits,
    case when p_credits > 0 then 'Credits added' else 'Credits removed' end,
    case when p_credits > 0 then p_amount_usd end,
    nullif(trim(coalesce(p_note, '')), ''),
    p_admin
  );
  return have + p_credits;
end;
$$;
revoke execute on function public.credit_topup(uuid, integer, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.credit_topup(uuid, integer, numeric, text, uuid) to service_role;

-- =====================================================================
-- 17. Admin panel reads (service role only)
-- =====================================================================

-- Every business (or one) with its login, setup, balance, usage, payments, our cost and activity
create or replace function public.admin_businesses(p_business_id uuid default null)
returns table (
  id uuid,
  name text,
  logo_key text,
  email text,
  onboarding_status text,
  paused boolean,
  credits integer,
  fees_due jsonb,
  budget_usd numeric,
  created_at timestamptz,
  used_month integer,
  used_30d integer,
  added_total integer,
  paid_usd numeric,
  last_topup_at timestamptz,
  cost_month numeric,
  posts_30d integer,
  last_active timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    coalesce(p.name, ''),
    p.logo_key,
    u.email::text,
    coalesce(p.onboarding_status, 'not_started'),
    coalesce(s.paused, false),
    b.credits,
    b.fees_due,
    s.monthly_budget_usd,
    b.created_at,
    coalesce((select -sum(l.credits) from public.credit_ledger l where l.business_id = b.id and l.kind in ('charge', 'refund') and l.created_at >= date_trunc('month', now())), 0)::integer,
    coalesce((select -sum(l.credits) from public.credit_ledger l where l.business_id = b.id and l.kind in ('charge', 'refund') and l.created_at >= now() - interval '30 days'), 0)::integer,
    coalesce((select sum(l.credits) from public.credit_ledger l where l.business_id = b.id and l.kind in ('topup', 'adjust')), 0)::integer,
    coalesce((select sum(l.amount_usd) from public.credit_ledger l where l.business_id = b.id), 0),
    (select max(l.created_at) from public.credit_ledger l where l.business_id = b.id and l.kind = 'topup'),
    coalesce((select sum(r.cost_usd) from public.agent_runs r where r.business_id = b.id and r.created_at >= date_trunc('month', now())), 0),
    (select count(*) from public.post_targets t where t.business_id = b.id and t.status = 'published' and t.published_at >= now() - interval '30 days')::integer,
    greatest(
      (select max(r.created_at) from public.agent_runs r where r.business_id = b.id),
      (select max(l.created_at) from public.credit_ledger l where l.business_id = b.id and l.kind = 'charge')
    )
  from public.businesses b
  left join public.business_profile p on p.business_id = b.id
  left join public.app_settings s on s.business_id = b.id
  left join auth.users u on u.id = b.owner_id
  where p_business_id is null or b.id = p_business_id
  order by b.created_at desc
$$;
revoke execute on function public.admin_businesses(uuid) from public, anon, authenticated;
grant execute on function public.admin_businesses(uuid) to service_role;

-- Credits used (charges less refunds) per business and action in a period
create or replace function public.admin_usage(p_since timestamptz, p_until timestamptz, p_business_id uuid default null)
returns table (business_id uuid, action text, used integer, uses integer)
language sql
stable
set search_path = ''
as $$
  select
    l.business_id,
    coalesce(l.action, 'other'),
    (-sum(l.credits))::integer,
    (count(*) filter (where l.kind = 'charge') - count(*) filter (where l.kind = 'refund'))::integer
  from public.credit_ledger l
  where l.kind in ('charge', 'refund')
    and l.created_at >= p_since
    and l.created_at < p_until
    and (p_business_id is null or l.business_id = p_business_id)
  group by 1, 2
$$;
revoke execute on function public.admin_usage(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.admin_usage(timestamptz, timestamptz, uuid) to service_role;

-- Per day, week or month: credits used, credits added, money paid and our AI cost (all businesses, or one)
create or replace function public.admin_series(p_since timestamptz, p_until timestamptz, p_unit text default 'day', p_business_id uuid default null)
returns table (bucket date, used integer, added integer, paid numeric, ai_cost numeric)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_unit not in ('day', 'week', 'month') then
    raise exception 'Unit must be day, week or month';
  end if;
  return query
  with buckets as (
    select generate_series(date_trunc(p_unit, p_since), date_trunc(p_unit, p_until - interval '1 microsecond'), ('1 ' || p_unit)::interval) as t
  ),
  ledger as (
    select
      date_trunc(p_unit, l.created_at) as t,
      -sum(l.credits) filter (where l.kind in ('charge', 'refund')) as used,
      sum(l.credits) filter (where l.kind in ('topup', 'adjust')) as added,
      sum(l.amount_usd) as paid
    from public.credit_ledger l
    where l.created_at >= p_since and l.created_at < p_until and (p_business_id is null or l.business_id = p_business_id)
    group by 1
  ),
  costs as (
    select date_trunc(p_unit, r.created_at) as t, sum(r.cost_usd) as cost
    from public.agent_runs r
    where r.created_at >= p_since and r.created_at < p_until and (p_business_id is null or r.business_id = p_business_id)
    group by 1
  )
  select b.t::date, coalesce(l.used, 0)::integer, coalesce(l.added, 0)::integer, coalesce(l.paid, 0)::numeric, coalesce(c.cost, 0)::numeric
  from buckets b
  left join ledger l on l.t = b.t
  left join costs c on c.t = b.t
  order by b.t;
end;
$$;
revoke execute on function public.admin_series(timestamptz, timestamptz, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_series(timestamptz, timestamptz, text, uuid) to service_role;

-- Our AI cost per business in a period (agent_runs), for the usage screen's margin
create or replace function public.admin_ai_cost(p_since timestamptz, p_until timestamptz)
returns table (business_id uuid, cost numeric)
language sql
stable
set search_path = ''
as $$
  select r.business_id, coalesce(sum(r.cost_usd), 0)
  from public.agent_runs r
  where r.created_at >= p_since and r.created_at < p_until
  group by r.business_id
$$;
revoke execute on function public.admin_ai_cost(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_ai_cost(timestamptz, timestamptz) to service_role;
