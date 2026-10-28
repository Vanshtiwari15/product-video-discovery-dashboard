const now = () => new Date().toISOString();
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = (value) => (value ? JSON.parse(value) : null);

// All SQL lives here so the rest of the code works with plain objects.
export function createRepo(db) {
  const stmt = {
    insertSearch: db.prepare(`INSERT INTO searches (id, input_type, input_text, has_upload, status, stage, is_demo, created_at)
      VALUES (@id, @inputType, @inputText, @hasUpload, 'queued', 'queued', @isDemo, @createdAt)`),
    updateSearch: db.prepare(`UPDATE searches SET status = COALESCE(@status, status), stage = COALESCE(@stage, stage),
      product_id = COALESCE(@productId, product_id), source_summary = COALESCE(@sourceSummary, source_summary),
      error = COALESCE(@error, error), finished_at = COALESCE(@finishedAt, finished_at) WHERE id = @id`),
    getSearch: db.prepare('SELECT * FROM searches WHERE id = ?'),
    listSearches: db.prepare(`SELECT s.*, p.title AS product_title, p.image_hash AS product_image_hash,
      (SELECT COUNT(*) FROM search_videos sv WHERE sv.search_id = s.id AND sv.match_status = 'accepted' AND sv.previously_seen = 0) AS new_matches
      FROM searches s LEFT JOIN products p ON p.id = s.product_id ORDER BY s.created_at DESC LIMIT ?`),
    priorSearches: db.prepare("SELECT COUNT(*) AS n FROM searches WHERE product_id = ? AND id != ? AND status IN ('complete', 'partial')"),
    interruptRunning: db.prepare(`UPDATE searches SET status = 'interrupted', error = 'Server restarted before the search finished', finished_at = ?
      WHERE status IN ('queued', 'running')`),

    upsertProduct: db.prepare(`INSERT INTO products (id, source_url, title, description, image_url, image_hash, attributes, queries, analysis_method, created_at, updated_at)
      VALUES (@id, @sourceUrl, @title, @description, @imageUrl, @imageHash, @attributes, @queries, @analysisMethod, @now, @now)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, image_url = excluded.image_url,
      image_hash = excluded.image_hash, attributes = excluded.attributes, queries = excluded.queries,
      analysis_method = excluded.analysis_method, updated_at = excluded.updated_at`),
    getProduct: db.prepare('SELECT * FROM products WHERE id = ?'),

    getPageCache: db.prepare('SELECT * FROM page_cache WHERE url_hash = ?'),
    putPageCache: db.prepare(`INSERT INTO page_cache (url_hash, url, data, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`),
    getAnalysisCache: db.prepare('SELECT data, created_at FROM image_analysis_cache WHERE cache_key = ?'),
    putAnalysisCache: db.prepare(`INSERT INTO image_analysis_cache (cache_key, data, created_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`),

    upsertVideo: db.prepare(`INSERT INTO videos (video_key, platform, platform_id, url, video_url, thumbnail_file, caption, author, published_at, phash, extra, is_demo, first_seen_at)
      VALUES (@videoKey, @platform, @platformId, @url, @videoUrl, @thumbnailFile, @caption, @author, @publishedAt, @phash, @extra, @isDemo, @now)
      ON CONFLICT(video_key) DO UPDATE SET thumbnail_file = COALESCE(excluded.thumbnail_file, videos.thumbnail_file),
      phash = COALESCE(excluded.phash, videos.phash), caption = COALESCE(excluded.caption, videos.caption)`),
    insertSearchVideo: db.prepare(`INSERT OR IGNORE INTO search_videos (search_id, video_key, platform, score, score_detail, match_status, previously_seen, found_by, created_at)
      VALUES (@searchId, @videoKey, @platform, @score, @scoreDetail, @matchStatus, @previouslySeen, @foundBy, @now)`),
    searchVideos: db.prepare(`SELECT sv.*, v.platform_id, v.url, v.video_url, v.thumbnail_file, v.caption, v.author, v.published_at, v.extra, v.is_demo
      FROM search_videos sv JOIN videos v ON v.video_key = sv.video_key WHERE sv.search_id = ? ORDER BY sv.score DESC`),

    seenAll: db.prepare('SELECT video_key, phash FROM seen_videos'),
    markSeen: db.prepare('INSERT OR IGNORE INTO seen_videos (video_key, first_search_id, phash, seen_at) VALUES (?, ?, ?, ?)'),
  };

  return {
    // Expose the raw DB handle so callers (e.g. tests) can close it before deleting the file.
    db,
    close() { db.close(); },

    createSearch({ id, inputType, inputText, hasUpload, isDemo }) {
      stmt.insertSearch.run({ id, inputType, inputText, hasUpload: hasUpload ? 1 : 0, isDemo: isDemo ? 1 : 0, createdAt: now() });
    },
    updateSearch(id, fields) {
      stmt.updateSearch.run({
        id,
        status: fields.status ?? null,
        stage: fields.stage ?? null,
        productId: fields.productId ?? null,
        sourceSummary: fields.sourceSummary ? json(fields.sourceSummary) : null,
        error: fields.error ?? null,
        finishedAt: fields.finished ? now() : null,
      });
    },
    getSearch(id) {
      const row = stmt.getSearch.get(id);
      return row && { ...row, source_summary: parse(row.source_summary) };
    },
    listSearches(limit = 50) {
      return stmt.listSearches.all(limit).map((row) => ({ ...row, source_summary: parse(row.source_summary) }));
    },
    countPriorSearches(productId, excludeId) {
      return stmt.priorSearches.get(productId, excludeId).n;
    },
    interruptRunningSearches() {
      return stmt.interruptRunning.run(now()).changes;
    },

    saveProduct(product) {
      stmt.upsertProduct.run({
        id: product.id,
        sourceUrl: product.sourceUrl ?? null,
        title: product.title ?? null,
        description: product.description ?? null,
        imageUrl: product.imageUrl ?? null,
        imageHash: product.imageHash ?? null,
        attributes: json(product.attributes),
        queries: json(product.queries),
        analysisMethod: product.analysisMethod ?? null,
        now: now(),
      });
    },
    getProduct(id) {
      const row = stmt.getProduct.get(id);
      return row && { ...row, attributes: parse(row.attributes), queries: parse(row.queries) };
    },

    getCachedPage(urlHash, ttlHours) {
      const row = stmt.getPageCache.get(urlHash);
      if (!row) return null;
      const ageHours = (Date.now() - Date.parse(row.fetched_at)) / 3_600_000;
      return ageHours <= ttlHours ? parse(row.data) : null;
    },
    cachePage(urlHash, url, data) {
      stmt.putPageCache.run(urlHash, url, json(data), now());
    },
    getCachedAnalysis(key, ttlMs = null) {
      const row = stmt.getAnalysisCache.get(key);
      if (!row) return null;
      const data = parse(row.data);
      if (ttlMs !== null && data?.providerFailure && Date.now() - Date.parse(row.created_at) > ttlMs) return null;
      return data;
    },
    cacheAnalysis(key, data) {
      stmt.putAnalysisCache.run(key, json(data), now());
    },

    // Writes the video and its link to the search in one transaction.
    saveSearchVideo(searchId, video, result) {
      db.transaction(() => {
        stmt.upsertVideo.run({
          videoKey: video.videoKey,
          platform: video.platform,
          platformId: video.platformId ?? null,
          url: video.url ?? null,
          videoUrl: video.videoUrl ?? null,
          thumbnailFile: video.thumbnailFile ?? null,
          caption: video.caption ?? null,
          author: video.author ?? null,
          publishedAt: video.publishedAt ?? null,
          phash: video.phash ?? null,
          extra: json(video.extra),
          isDemo: video.isDemo ? 1 : 0,
          now: now(),
        });
        stmt.insertSearchVideo.run({
          searchId,
          videoKey: video.videoKey,
          platform: video.platform,
          score: result.score ?? null,
          scoreDetail: json(result.detail),
          matchStatus: result.matchStatus,
          previouslySeen: result.previouslySeen ? 1 : 0,
          foundBy: video.foundBy ?? null,
          now: now(),
        });
      })();
    },
    getSearchVideos(searchId) {
      return stmt.searchVideos.all(searchId).map((row) => ({
        ...row,
        score_detail: parse(row.score_detail),
        extra: parse(row.extra),
      }));
    },

    loadSeen() {
      return stmt.seenAll.all();
    },
    markSeen(videoKeys, searchId, phashByKey = new Map()) {
      db.transaction(() => {
        for (const key of videoKeys) stmt.markSeen.run(key, searchId, phashByKey.get(key) ?? null, now());
      })();
    },
  };
}
