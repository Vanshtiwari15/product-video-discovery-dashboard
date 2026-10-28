CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  input_type TEXT NOT NULL,
  input_text TEXT NOT NULL,
  has_upload INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stage TEXT,
  product_id TEXT,
  source_summary TEXT,
  error TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  source_url TEXT,
  title TEXT,
  description TEXT,
  image_url TEXT,
  image_hash TEXT,
  attributes TEXT,
  queries TEXT,
  analysis_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_cache (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_analysis_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  video_key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_id TEXT,
  url TEXT,
  video_url TEXT,
  thumbnail_file TEXT,
  caption TEXT,
  author TEXT,
  published_at TEXT,
  phash TEXT,
  extra TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_videos (
  search_id TEXT NOT NULL REFERENCES searches(id),
  video_key TEXT NOT NULL REFERENCES videos(video_key),
  platform TEXT NOT NULL,
  score INTEGER,
  score_detail TEXT,
  match_status TEXT NOT NULL,
  previously_seen INTEGER NOT NULL DEFAULT 0,
  found_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (search_id, video_key)
);

CREATE TABLE IF NOT EXISTS seen_videos (
  video_key TEXT PRIMARY KEY,
  first_search_id TEXT NOT NULL,
  phash TEXT,
  seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_videos_search ON search_videos(search_id, platform);
CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
