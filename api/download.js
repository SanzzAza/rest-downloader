/**
 * Vercel Serverless Function — REST DOWNLOADER (REAL SCRAPING)
 * Endpoint: /api/download
 * Query: ?platform=tiktok|instagram&url=<url>
 * Return: JSON langsung dari scraping / oEmbed / GraphQL publik
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { platform, url } = req.query;

  if (!platform || !url) {
    return res.status(400).json({ status: "error", message: "Parameter 'platform' dan 'url' wajib diisi." });
  }

  const allowed = ["tiktok", "instagram", "facebook", "twitter", "threads"];
  if (!allowed.includes(platform.toString().toLowerCase())) {
    return res.status(400).json({ status: "error", message: `Platform tidak didukung: ${platform}` });
  }

  try {
    new URL(url.toString());
  } catch {
    return res.status(400).json({ status: "error", message: "URL tidak valid." });
  }

  const p = platform.toString().toLowerCase();
  const result = await scrapeReal(p, url.toString());
  return res.status(result.status === "success" ? 200 : 500).json(result);
}

/* ============================================================
   SCRAPING REAL - TIKTOK & INSTAGRAM
   ============================================================ */

async function scrapeReal(platform, url) {
  const timestamp = new Date().toISOString();

  // --- TIKTOK ---
  if (platform === "tiktok") {
    try {
      // 1. Ambil data dari oEmbed publik TikTok (real endpoint)
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      const oembedRes = await fetch(oembedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "application/json"
        }
      });

      if (!oembedRes.ok) {
        return buildError(platform, url, `TikTok oEmbed gagal: HTTP ${oembedRes.status}`);
      }

      const oembed = await oembedRes.json();

      // 2. Coba ekstrak video URL dari embed HTML atau coba fetch halaman
      let videoUrl = null;
      let thumbnail = oembed.thumbnail_url || null;

      // Coba parse HTML embed untuk link video
      if (oembed.html) {
        const vidMatch = oembed.html.match(/src="([^"]+\.mp4[^"]*)"/);
        if (vidMatch) videoUrl = vidMatch[1];
      }

      // Coba fetch halaman video untuk meta tag atau JSON internal
      try {
        const pageRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.tiktok.com/"
          },
          signal: AbortSignal.timeout(8000)
        });
        const html = await pageRes.text();

        // Cari JSON SIGI_STATE atau __UNIVERSAL_DATA_FOR_WEB
        const sigiMatch = html.match(/SIGI_STATE\s*=\s*({.+?});/s);
        if (sigiMatch) {
          try {
            const sigi = JSON.parse(sigiMatch[1]);
            const item = sigi.ItemModule?.[Object.keys(sigi.ItemModule || {})[0]]?.video;
            if (item && item.playAddr) {
              videoUrl = item.playAddr;
            }
          } catch (e) { /* parse gagal */ }
        }

        // Cari meta tag video
        const metaVideo = html.match(/property="og:video"[^>]*content="([^"]+)"/);
        if (metaVideo) videoUrl = metaVideo[1];

        // Cari dari script JSON
        const initialState = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
        if (initialState) {
          try {
            const state = JSON.parse(initialState[1]);
            const videoData = state?.videoData?.video || state?.videoDetail?.videoData?.video;
            if (videoData && videoData.playAddr) videoUrl = videoData.playAddr;
          } catch (e) { /* parse gagal */ }
        }
      } catch (e) {
        // Scraping halaman gagal (bot block), tetap lanjut dengan data oEmbed
      }

      return {
        status: "success",
        platform: "tiktok",
        source_url: url,
        scraped_at: timestamp,
        method: "tiktok_oembed_real_scrape",
        data: {
          video_url: videoUrl || (oembed.embed_type === "video" ? `https://www.tiktok.com/embed/v3/${oembed.embed_product_id || extractVideoId(url)}` : null),
          thumbnail: thumbnail,
          caption: oembed.title || "Tidak ada caption",
          author: oembed.author_name || "Unknown",
          author_url: oembed.author_url || null,
          likes: null, // Memerlukan endpoint internal / login
          comments: null,
          duration_seconds: null,
          resolution: null,
          video_id: extractVideoId(url) || oembed.embed_product_id || null
        },
        meta: {
          oembed_available: true,
          scraping_note: videoUrl ? "Video URL berhasil diekstrak dari halaman atau meta." : "Video URL belum bisa diekstrak (bot protection / JS render). Gunakan proxy atau service pihak ketiga untuk URL langsung yang stabil.",
          deploy_target: "vercel_serverless"
        }
      };
    } catch (err) {
      return buildError("tiktok", url, err.message);
    }
  }

  // --- INSTAGRAM ---
  if (platform === "instagram") {
    try {
      // 1. Ambil oEmbed Meta Graph (tokenless sejak Juni 2026)
      const oembedUrl = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encodeURIComponent(url)}`;
      const oembedRes = await fetch(oembedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        }
      });

      let oembed = null;
      if (oembedRes.ok) {
        try { oembed = await oembedRes.json(); } catch (e) {}
      }

      // 2. Coba scraping halaman publik untuk JSON internal
      let videoUrl = null;
      let thumbnail = oembed?.thumbnail_url || null;
      let caption = oembed?.title || "Caption tidak tersedia";
      let author = oembed?.author_name || "Unknown";

      try {
        const pageRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
          },
          signal: AbortSignal.timeout(8000)
        });
        const html = await pageRes.text();

        // Cari JSON dalam <script type="application/ld+json">
        const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
        if (ldJsonMatch) {
          try {
            const ld = JSON.parse(ldJsonMatch[1]);
            caption = ld.caption || caption;
            videoUrl = ld.video?.url || videoUrl;
          } catch (e) {}
        }

        // Cari meta tag
        const metaVideo = html.match(/property="og:video"[^>]*content="([^"]+)"/);
        if (metaVideo) videoUrl = metaVideo[1];

        const metaThumb = html.match(/property="og:image"[^>]*content="([^"]+)"/);
        if (metaThumb && !thumbnail) thumbnail = metaThumb[1];

      } catch (e) {
        // Scraping halaman gagal
      }

      return {
        status: "success",
        platform: "instagram",
        source_url: url,
        scraped_at: timestamp,
        method: "instagram_graph_oembed_real_scrape",
        data: {
          video_url: videoUrl,
          thumbnail: thumbnail,
          caption: caption,
          author: author,
          author_url: oembed?.author_url || null,
          likes: null,
          comments: null,
          duration_seconds: null,
          resolution: null,
          shortcode: extractIGShortcode(url)
        },
        meta: {
          oembed_available: !!oembed,
          scraping_note: oembed ? "Data diambil dari Graph oEmbed Meta (tokenless). Video URL mungkin memerlukan token atau login untuk akses stabil." : "oEmbed gagal. Mungkin URL tidak publik atau endpoint berubah.",
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
        scraped_at: timestamp,
        method: "facebook_oembed",
        data: {
          video_url: data?.video?.src || null,
          thumbnail: data?.thumbnail_url || null,
          caption: data?.title || null,
          author: data?.author_name || null,
          likes: null,
          comments: null
        },
        meta: { note: "Facebook oEmbed memerlukan App Token untuk produksi stabil." }
      };
    } catch (err) {
      return buildError("facebook", url, err.message);
    }
  }

  // --- TWITTER / X ---
  if (platform === "twitter" || platform === "threads") {
    return {
      status: "pending",
      platform: platform,
      source_url: url,
      scraped_at: timestamp,
      message: `Platform ${platform} belum memiliki scraper aktif. Silakan tambahkan endpoint scraping atau GraphQL untuk platform ini.`,
      method: "not_implemented"
    };
  }

  return buildError(platform, url, "Metode scraping tidak ditemukan untuk platform ini.");
}

/* ============================================================
   HELPER
   ============================================================ */

function buildError(platform, url, message) {
  return {
    status: "error",
    platform,
    source_url: url,
    message,
    timestamp: new Date().toISOString(),
    note: "Pastikan URL publik dan tidak dibatasi bot. Coba dengan User-Agent yang berbeda atau proxy jika diblokir."
  };
}

function extractVideoId(url) {
  const m = url.match(/video\/(\d+)/);
  return m ? m[1] : null;
}

function extractIGShortcode(url) {
  const m = url.match(/\/p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
