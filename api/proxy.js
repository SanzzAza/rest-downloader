/**
 * PROXY SERVER — REST DOWNLOADER
 * Endpoint: GET /api/proxy?url=<tiktok-url>&mode=video|oembed|feed
 * Fungsi: bypass CORS + proxy request TikTok agar tidak kena blokir langsung
 */

export default async function handler(req, res) {
  // CORS total
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, mode } = req.query;
  if (!url) return res.status(400).json({ status: "error", message: "Parameter 'url' wajib diisi." });

  try {
    const targetUrl = String(url);
    let proxyUrl = targetUrl;

    if (mode === 'feed' || targetUrl.includes('tiktok.com')) {
      // Extract video ID dan coba endpoint internal
      const videoId = targetUrl.match(/video\/(\d+)/)?.[1];
      if (videoId && mode === 'feed') {
        proxyUrl = `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&count=1`;
      }
    }

    const response = await fetch(proxyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.tiktok.com/",
        "X-Gorgon": "8404b05e5000b0e8a6c5d3e2f1a0b9c8",
        "X-Khronos": String(Date.now()),
        "Connection": "keep-alive"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(8000)
    });

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return res.status(200).json({
      status: "proxy_ok",
      proxy_target: proxyUrl,
      response_status: response.status,
      content_type: contentType,
      data: data,
      timestamp: new Date().toISOString(),
      note: "Proxy berhasil. Gunakan endpoint ini dari frontend untuk bypass CORS dan akses langsung ke TikTok."
    });
  } catch (err) {
    return res.status(500).json({
      status: "proxy_error",
      message: err.message,
      note: "Proxy gagal — kemungkinan CORS atau endpoint diblokir oleh TikTok."
    });
  }
}
