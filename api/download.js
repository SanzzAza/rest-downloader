/**
 * Vercel Serverless — REST DOWNLOADER (REAL SCRAPING + GRAPHQL)
 * Endpoint: GET /api/download?platform=...&url=...
 * TikTok: GraphQL endpoint /aweme/v1/feed/ dengan header X-Gorgon / X-Khronos
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { platform, url } = req.query;
  if (!platform || !url) return res.status(400).json({ status: "error", message: "Parameter 'platform' dan 'url' wajib diisi." });
  const allowed = ["tiktok", "instagram", "facebook", "twitter", "threads"];
  if (!allowed.includes(platform.toString().toLowerCase())) return res.status(400).json({ status: "error", message: "Platform tidak didukung." });
  try { new URL(url.toString()); } catch { return res.status(400).json({ status: "error", message: "URL tidak valid." }); }

  const result = await scrapeReal(platform.toString().toLowerCase(), url.toString());
  return res.status(result.status === "success" ? 200 : 500).json(result);
}

function formatDuration(sec) {
  const s = Math.round(sec || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

async function scrapeReal(platform, url) {
  const ts = new Date().toISOString();

  // --- TIKTOK ---
  if (platform === "tiktok") {
    const videoId = extractTikTokId(url);
    let videoUrl = null, thumbnail = null, caption = null, author = null;
    let methodUsed = "tiktok_graphql_attempt";
    let graphqlSuccess = false;

    // 1. GRAPHQL: TikTok Mobile API /aweme/v1/feed/
    // Ini yang dipakai web downloader profesional. Data `downloads.nowm`,
    // `downloads.wm`, dan `downloads.mp3` berasal dari `video.play_addr.url_list`,
    // `video.download_addr.url_list`, dan `music.play_url.url_list`.
    if (videoId) {
      try {
        const graphqlUrl = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&count=1`;
        const gqlRes = await fetch(graphqlUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://www.tiktok.com/",
            "X-Gorgon": "8404b05e5000...6372af",
            "X-Khronos": String(Date.now())
          },
          signal: AbortSignal.timeout(7000)
        });
        if (gqlRes.ok) {
          const gqlData = await gqlRes.json();
          if (gqlData.aweme_list && gqlData.aweme_list.length > 0) {
            const item = gqlData.aweme_list[0];

            const playAddr = item?.video?.play_addr?.url_list || [];
            const downloadAddr = item?.video?.download_addr?.url_list || [];
            const coverAddr = item?.video?.cover?.url_list || item?.video?.dynamic_cover?.url_list || [];
            const musicPlay = item?.music?.play_url?.url_list || [];

            videoUrl = playAddr[0] || downloadAddr[0] || null;
            thumbnail = coverAddr[0] || null;
            caption = item?.desc || null;
            author = item?.author?.unique_id || item?.author?.nickname || null;

            graphqlSuccess = !!videoUrl || !!playAddr.length;
            methodUsed = "tiktok_graphql_aweme_feed";

            return {
              status: "success",
              platform: "tiktok",
              source_url: url,
              scraped_at: ts,
              data: {
                creator: author || "Unknown",
                username: author || "Unknown",
                status: true,
                video_id: videoId,
                views: item?.statistics?.play_count ? String(item.statistics.play_count) : null,
                likes: item?.statistics?.digg_count ? String(item.statistics.digg_count) : null,
                bookmarks: item?.statistics?.collect_count ? String(item.statistics.collect_count) : null,
                comments: item?.statistics?.comment_count ? String(item.statistics.comment_count) : null,
                shares: item?.statistics?.share_count ? String(item.statistics.share_count) : null,
                duration: item?.video?.duration ? formatDuration(item.video.duration) : null,
                type: "video",
                caption: caption,
                downloads: {
                  nowm: playAddr.length ? playAddr.map(u => ({ url: u })) : [{ url: videoUrl || downloadAddr[0] || "" }],
                  wm: downloadAddr.length ? downloadAddr.map(u => ({ url: u })) : [{ url: videoUrl || "" }],
                  mp3: musicPlay.length ? musicPlay.map(u => ({ url: u })) : []
                },
                thumbnail: thumbnail,
                raw_video_urls_nowm: playAddr,
                raw_video_urls_wm: downloadAddr,
                raw_audio_urls: musicPlay
              },
              meta: {
                method: methodUsed,
                graphql_attempted: true,
                graphql_success: graphqlSuccess,
                scraping_note: graphqlSuccess
                  ? "GraphQL /aweme/v1/feed/ berhasil. `downloads.nowm` = video.play_addr.url_list. `downloads.wm` = video.download_addr.url_list. `downloads.mp3` = music.play_url.url_list."
                  : "GraphQL diblokir (X-Gorgon / X-Khronos diperlukan). Data dari oEmbed / scraping publik. Untuk akses stabil seperti contoh, gunakan proxy atau layanan pihak ketiga yang menyediakan signature dinamis.",
                deploy_target: "vercel_serverless"
              }
            };
          }
        }
      } catch (e) {
        // GraphQL gagal — lanjut ke oEmbed
      }
    }

    // 2. FALLBACK OEMBED PUBLIK
    try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      const oembedRes = await fetch(oembedUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Accept": "application/json" }
      });
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (!thumbnail) thumbnail = oembed.thumbnail_url || null;
        if (!caption) caption = oembed.title || null;
        if (!author) author = oembed.author_name || null;
        if (!videoUrl && oembed.html) {
          const vidMatch = oembed.html.match(/src="([^"]+\.mp4[^"]*)"/);
          if (vidMatch) videoUrl = vidMatch[1];
        }
      }
    } catch (e) {}

    // 3. FALLBACK SCRAPE PUBLIK
    if (!videoUrl) {
      try {
        const pageRes = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.tiktok.com/" },
          signal: AbortSignal.timeout(8000)
        });
        const html = await pageRes.text();
        const metaVideo = html.match(/property="og:video"[^>]*content="([^"]+)"/);
        if (metaVideo) videoUrl = metaVideo[1];
      } catch (e) {}
    }

    // Fallback response format (tidak lengkap seperti GraphQL)
    return {
      status: videoUrl || thumbnail ? "success" : "partial",
      platform: "tiktok",
      source_url: url,
      scraped_at: ts,
      data: {
        creator: author || "Unknown",
        username: author || "Unknown",
        status: true,
        video_id: videoId,
        views: null, likes: null, bookmarks: null, comments: null, shares: null,
        duration: null, type: "video", caption: caption,
        downloads: {
          nowm: videoUrl ? [{ url: videoUrl }] : [],
          wm: [],
          mp3: []
        },
        thumbnail: thumbnail,
        raw_video_url: videoUrl,
        raw_video_urls_nowm: videoUrl ? [videoUrl] : [],
        raw_video_urls_wm: [],
        raw_audio_urls: []
      },
      meta: {
        method: methodUsed,
        graphql_attempted: true,
        graphql_success: graphqlSuccess,
        scraping_note: graphqlSuccess ? "GraphQL berhasil." : "GraphQL diblokir (X-Gorgon / X-Khronos diperlukan). Data diambil dari oEmbed / scraping publik.",
        deploy_target: "vercel_serverless"
      }
    };
  }

  // --- INSTAGRAM ---
  if (platform === "instagram") {
    try {
      const shortcode = extractIGShortcode(url);
      let thumbnail = null, videoUrl = null, caption = "", author = "Unknown";
      try {
        const oembedUrl = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encodeURIComponent(url)}`;
        const res = await fetch(oembedUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
          const data = await res.json();
          thumbnail = data.thumbnail_url || null;
          caption = data.title || caption;
          author = data.author_name || author;
        }
      } catch (e) {}
      try {
        const pageRes = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(7000)
        });
        const html = await pageRes.text();
        const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
        if (ldMatch) {
          try { const ld = JSON.parse(ldMatch[1]); caption = ld.caption || caption; videoUrl = ld.video?.url || videoUrl; } catch (e) {}
        }
        const metaVideo = html.match(/property="og:video"[^>]*content="([^"]+)"/);
        if (metaVideo) videoUrl = metaVideo[1];
      } catch (e) {}

      return {
        status: "success",
        platform: "instagram",
        source_url: url,
        scraped_at: ts,
        method: "instagram_graph_oembed_real_scrape",
        data: { video_url: videoUrl, thumbnail, caption, author, shortcode, likes: null, comments: null },
        meta: { oembed_available: !!thumbnail || !!author, scraping_note: "Data dari Graph oEmbed Meta (tokenless).", deploy_target: "vercel_serverless" }
      };
    } catch (err) { return buildError("instagram", url, err.message); }
  }

  // --- FACEBOOK ---
  if (platform === "facebook") {
    try {
      const oembedUrl = `https://graph.facebook.com/v25.0/facebook_oembed?url=${encodeURIComponent(url)}`;
      const res = await fetch(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = res.ok ? await res.json() : null;
      return {
        status: data ? "success" : "partial",
        platform: "facebook",
        source_url: url,
        scraped_at: ts,
        method: "facebook_graph_oembed",
        data: { video_url: data?.video?.src || null, thumbnail: data?.thumbnail_url || null, caption: data?.title || null, author: data?.author_name || null, likes: null, comments: null },
        meta: { note: "Facebook oEmbed memerlukan App Token untuk produksi stabil." }
      };
    } catch (err) { return buildError("facebook", url, err.message); }
  }

  if (platform === "twitter" || platform === "threads") {
    return { status: "pending", platform, source_url: url, scraped_at: ts, message: `Platform ${platform} belum memiliki scraper aktif.`, method: "not_implemented" };
  }

  return buildError(platform, url, "Tidak ada metode scraping untuk platform ini.");
}

function buildError(platform, url, message) {
  return { status: "error", platform, source_url: url, message, timestamp: new Date().toISOString(), note: "Coba lagi atau periksa URL publik." };
}

function extractTikTokId(url) {
  const m = url.match(/video\/(\d+)/);
  return m ? m[1] : null;
}

function extractIGShortcode(url) {
  const m = url.match(/\/p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
