/**
 * Vercel Serverless — REST DOWNLOADER (REAL SCRAPING + GRAPHQL)
 * Endpoint: GET /api/download?platform=...&url=...
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

async function scrapeReal(platform, url) {
  const ts = new Date().toISOString();

  // --- TIKTOK (GRAPHQL + OEMBED) ---
  if (platform === "tiktok") {
    const videoId = extractTikTokId(url);
    let videoUrl = null;
    let thumbnail = null;
    let caption = null;
    let author = null;
    let methodUsed = "tiktok_graphql_attempt";
    let graphqlSuccess = false;

    // 1. COBA GRAPHQL ENDPOINT TIKTOK (Mobile API /aweme/v1/feed/)
    if (videoId) {
      try {
        const graphqlUrl = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&count=1`;
        const gqlRes = await fetch(graphqlUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://www.tiktok.com/",
            "X-Gorgon": "8404b05e5000...6372af", // Placeholder — produksi butuh signature dinamis
            "X-Khronos": String(Date.now())
          },
          signal: AbortSignal.timeout(7000)
        });
        if (gqlRes.ok) {
          const gqlData = await gqlRes.json();
          if (gqlData.aweme_list && gqlData.aweme_list.length > 0) {
            const item = gqlData.aweme_list[0];
            const playAddr = item?.video?.play_addr?.url_list?.[0] || item?.video?.download_addr?.url_list?.[0];
            if (playAddr) videoUrl = playAddr;
            thumbnail = item?.video?.cover?.url_list?.[0] || item?.video?.dynamic_cover?.url_list?.[0] || null;
            caption = item?.desc || null;
            author = item?.author?.unique_id || item?.author?.nickname || null;
            graphqlSuccess = !!playAddr;
            methodUsed = "tiktok_graphql_aweme_feed";
          }
        }
      } catch (e) {
        // GraphQL gagal (signature salah / bot block) — lanjut ke oEmbed
      }
    }

    // 2. FALLBACK: OEMBED PUBLIK TIKTOK (REAL DATA)
    if (!videoUrl || !thumbnail) {
      try {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
        const oembedRes = await fetch(oembedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "application/json"
          }
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
      } catch (e) { /* oEmbed gagal */ }
    }

    // 3. COBA SCRAPE HALAMAN PUBLIK UNTUK VIDEO URL
    if (!videoUrl) {
      try {
        const pageRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.tiktok.com/"
          },
          signal: AbortSignal.timeout(8000)
        });
        const html = await pageRes.text();
        const metaVideo = html.match(/property="og:video"[^>]*content="([^"]+)"/);
        if (metaVideo) videoUrl = metaVideo[1];
      } catch (e) { /* scraping gagal */ }
    }

    return {
      status: "success",
      platform: "tiktok",
      source_url: url,
      scraped_at: ts,
      data: {
        video_url: videoUrl,
        thumbnail: thumbnail,
        caption: caption,
        author: author,
        video_id: videoId,
        likes: null,
        comments: null,
        resolution: null
      },
      meta: {
        method: methodUsed,
        graphql_attempted: true,
        graphql_success: graphqlSuccess,
        scraping_note: graphqlSuccess
          ? "GraphQL endpoint berhasil mengembalikan data video."
          : "GraphQL diblokir (X-Gorgon / X-Khronos diperlukan). Data diambil dari oEmbed / scraping publik. Untuk akses stabil, gunakan proxy atau layanan pihak ketiga yang menyediakan signature dinamis.",
        deploy_target: "vercel_serverless"
      }
    };
  }

  // --- INSTAGRAM (GRAPH OEMBED) ---
  if (platform === "instagram") {
    try {
      const shortcode = extractIGShortcode(url);
      let thumbnail = null, videoUrl = null, caption = "", author = "Unknown";

      // 1. GRAPH OEMBED META (tokenless sejak Juni 2026)
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

      // 2. SCRAPE HALAMAN PUBLIK UNTUK VIDEO URL / META
      try {
        const pageRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9"
          },
          signal: AbortSignal.timeout(7000)
        });
        const html = await pageRes.text();
        const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
        if (ldMatch) {
          try {
            const ld = JSON.parse(ldMatch[1]);
            caption = ld.caption || caption;
            videoUrl = ld.video?.url || videoUrl;
          } catch (e) {}
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
        meta: {
          oembed_available: !!thumbnail || !!author,
          scraping_note: "Data dari Graph oEmbed Meta (tokenless). Video URL mungkin memerlukan akses login untuk akses stabil.",
          deploy_target: "vercel_serverless"
        }
      };
    } catch (err) {
      return buildError("instagram", url, err.message);
    }
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
        data: {
          video_url: data?.video?.src || null,
          thumbnail: data?.thumbnail_url || null,
          caption: data?.title || null,
          author: data?.author_name || null,
          likes: null, comments: null
        },
        meta: { note: "Facebook oEmbed memerlukan App Token untuk produksi stabil." }
      };
    } catch (err) { return buildError("facebook", url, err.message); }
  }

  // --- TWITTER / THREADS ---
  if (platform === "twitter" || platform === "threads") {
    return {
      status: "pending",
      platform,
      source_url: url,
      scraped_at: ts,
      message: `Platform ${platform} belum memiliki scraper aktif. Tambahkan endpoint scraping atau GraphQL untuk platform ini.`,
      method: "not_implemented"
    };
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
