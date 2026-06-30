const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.160 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function cleanUrl(shortcode) {
  return `https://www.instagram.com/reel/${shortcode}/`;
}

function decodeUrl(s) {
  return (s || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
}

// ─── Method 1: snapsave.app (session-based) ───────────────────
async function trySnapsave(postUrl) {
  try {
    console.log('→ snapsave...');
    // Get home page + cookie
    const homeResp = await axios.get('https://snapsave.app/', {
      headers: { 'User-Agent': DESKTOP_UA },
      timeout: 12000,
      maxRedirects: 5,
    });

    const cookies = homeResp.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
    const tokenM = homeResp.data.match(/name="_token"\s+value="([^"]+)"/);
    const token = tokenM ? tokenM[1] : '';

    const resp = await axios.post('https://snapsave.app/action.php',
      new URLSearchParams({ url: postUrl, _token: token }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://snapsave.app/',
          'Origin': 'https://snapsave.app',
          'User-Agent': DESKTOP_UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': cookies,
        },
        timeout: 15000,
      }
    );

    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const mp4s = body.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/g);
    if (mp4s && mp4s[0]) {
      return { videoUrl: mp4s[0].replace(/&amp;/g, '&'), source: 'snapsave' };
    }

    // Try JSON parse
    try {
      const d = JSON.parse(body);
      const vUrl = d?.url || d?.video_url || d?.links?.[0]?.url;
      if (vUrl) return { videoUrl: vUrl, source: 'snapsave-json' };
    } catch {}

    // Try href patterns
    const hrefM = body.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (hrefM) return { videoUrl: hrefM[1].replace(/&amp;/g, '&'), source: 'snapsave-href' };

  } catch (e) {
    console.log('  snapsave failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 2: saveig.me ──────────────────────────────────────
async function trySaveig(postUrl) {
  try {
    console.log('→ saveig...');
    const resp = await axios.post('https://v2.saveig.me/api/ajaxSearch',
      new URLSearchParams({ q: postUrl, t: 'media', lang: 'en' }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://saveig.me/',
          'Origin': 'https://saveig.me',
          'User-Agent': DESKTOP_UA,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 15000,
      }
    );

    const d = resp.data;
    if (d?.status === 'ok' && d.data) {
      const html = d.data;
      // Find HD video first
      const hdM = html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"\s[^>]*>\s*HD/i);
      if (hdM) return { videoUrl: hdM[1].replace(/&amp;/g, '&'), source: 'saveig-hd' };

      const m = html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/);
      if (m) return { videoUrl: m[1].replace(/&amp;/g, '&'), source: 'saveig' };

      // Try JSON embedded
      const jsonM = html.match(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/);
      if (jsonM) return { videoUrl: decodeUrl(jsonM[1]), source: 'saveig-json' };
    }
  } catch (e) {
    console.log('  saveig failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 3: instasave.website ──────────────────────────────
async function tryInstasave(postUrl) {
  try {
    console.log('→ instasave...');
    const resp = await axios.post('https://instasave.website/api/',
      JSON.stringify({ url: postUrl }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://instasave.website/',
          'Origin': 'https://instasave.website',
          'User-Agent': DESKTOP_UA,
        },
        timeout: 12000,
      }
    );

    const d = resp.data;
    let vUrl = null;
    if (Array.isArray(d) && d.length > 0) {
      vUrl = d[0]?.url || d[0]?.downloadUrl || d[0]?.href;
    } else if (d?.url) {
      vUrl = d.url;
    } else if (d?.links?.length > 0) {
      vUrl = d.links[0]?.url;
    }
    if (vUrl) return { videoUrl: vUrl, source: 'instasave' };
  } catch (e) {
    console.log('  instasave failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 4: saveinsta.com ──────────────────────────────────
async function trySaveinstaApp(postUrl) {
  try {
    console.log('→ saveinsta...');
    // Get home to find the form action
    const home = await axios.get('https://saveinsta.app/', {
      headers: { 'User-Agent': MOBILE_UA },
      timeout: 10000,
    });

    const tokenM = home.data.match(/name="_token"\s+value="([^"]+)"/);
    const token = tokenM ? tokenM[1] : '';
    const cookies = home.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

    const resp = await axios.post('https://saveinsta.app/',
      new URLSearchParams({ url: postUrl, _token: token }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://saveinsta.app/',
          'Origin': 'https://saveinsta.app',
          'User-Agent': MOBILE_UA,
          'Cookie': cookies,
        },
        timeout: 20000,
        maxRedirects: 5,
      }
    );

    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const mp4M = body.match(/href="(https?:\/\/[^"]*\.mp4[^"]*)"/);
    if (mp4M) return { videoUrl: mp4M[1].replace(/&amp;/g, '&'), source: 'saveinsta' };

    const mp4Direct = body.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
    if (mp4Direct) return { videoUrl: mp4Direct[0].replace(/&amp;/g, '&'), source: 'saveinsta-direct' };
  } catch (e) {
    console.log('  saveinsta failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 5: yt-dlp ─────────────────────────────────────────
async function tryYtDlp(postUrl) {
  const ytdlpPaths = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];

  for (const ytPath of ytdlpPaths) {
    try {
      console.log(`→ yt-dlp (${ytPath})...`);
      const { stdout } = await execFileAsync(ytPath, [
        '--no-playlist', '--no-warnings',
        '--print', 'url', '--print', 'thumbnail', '--print', 'title',
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--no-check-certificates',
        '--socket-timeout', '20',
        postUrl,
      ], { timeout: 35000, maxBuffer: 1024 * 1024 * 10 });

      const lines = stdout.trim().split('\n').filter(Boolean);
      const videoUrl = lines[0]?.trim();
      if (videoUrl?.startsWith('http')) {
        return {
          videoUrl,
          thumbnail: lines[1]?.trim() || null,
          title: lines[2]?.trim() || 'Instagram Video',
          source: 'yt-dlp',
        };
      }
    } catch (e) {
  console.error("===== YT-DLP ERROR =====");
  console.error("Message:", e.message);

  if (e.stdout) {
    console.error("STDOUT:");
    console.error(e.stdout);
  }

  if (e.stderr) {
    console.error("STDERR:");
    console.error(e.stderr);
  }

  console.error("========================");
}
  }
  return null;
}

// ─── Method 6: Instagram embed page ───────────────────────────
async function tryEmbed(shortcode) {
  try {
    console.log('→ embed...');
    const resp = await axios.get(`https://www.instagram.com/p/${shortcode}/embed/`, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Referer': 'https://www.instagram.com/',
        'Accept': 'text/html',
      },
      timeout: 15000,
    });
    const html = resp.data;
    const patterns = [
      /"video_url"\s*:\s*"([^"]+)"/,
      /"playback_url"\s*:\s*"([^"]+)"/,
      /src="(https?:\/\/[^"]+scontent[^"]+\.mp4[^"]*)"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        const vUrl = decodeUrl(m[1]);
        if (vUrl.startsWith('http')) return { videoUrl: vUrl, source: 'embed' };
      }
    }
  } catch (e) {
    console.log('  embed failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 7: fastdl ─────────────────────────────────────────
async function tryFastdl(postUrl) {
  try {
    console.log('→ fastdl...');
    const resp = await axios.post('https://fastdl.app/api/convert',
      JSON.stringify({ url: postUrl }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://fastdl.app/',
          'Origin': 'https://fastdl.app',
          'User-Agent': DESKTOP_UA,
        },
        timeout: 15000,
      }
    );

    const d = resp.data;
    const bodyStr = JSON.stringify(d);
    const mp4M = bodyStr.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    if (mp4M) return { videoUrl: mp4M[1].replace(/\\u0026/g, '&'), source: 'fastdl' };

    if (d?.url) return { videoUrl: d.url, source: 'fastdl-direct' };
    if (d?.links?.[0]?.url) return { videoUrl: d.links[0].url, source: 'fastdl-links' };
  } catch (e) {
    console.log('  fastdl failed:', e.message?.slice(0, 80));
  }
  return null;
}

// ─── Method 8: aio-dl WordPress plugin API ────────────────────
async function tryAioDl(postUrl) {
  const sites = [
    'https://publer.com/wp-json/aio-dl/video-data/',
    'https://inflact.com/wp-json/aio-dl/video-data/',
  ];

  for (const site of sites) {
    try {
      console.log(`→ aio-dl (${site.slice(8, 30)})...`);
      const resp = await axios.post(site,
        new URLSearchParams({ postLink: postUrl }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': site.split('wp-json')[0],
            'User-Agent': DESKTOP_UA,
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: 12000,
        }
      );

      const d = resp.data;
      const medias = d?.medias || [];
      for (const m of medias) {
        if (m?.url && (m.url.includes('.mp4') || m.extension === 'mp4')) {
          return { videoUrl: m.url, thumbnail: d.thumbnail, title: d.title, source: 'aio-dl' };
        }
      }
      // Check all URLs in response
      const bodyStr = JSON.stringify(d);
      const mp4M = bodyStr.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
      if (mp4M) return { videoUrl: decodeUrl(mp4M[1]), source: 'aio-dl-mp4' };
      if (d?.url) return { videoUrl: d.url, source: 'aio-dl' };
    } catch (e) {
      console.log(`  aio-dl (${site.slice(8, 30)}) failed:`, e.message?.slice(0, 60));
    }
  }
  return null;
}

// ─── /api/fetch ───────────────────────────────────────────────
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL tələb olunur' });
  if (!url.includes('instagram.com')) {
    return res.status(400).json({ success: false, error: 'Yalnız Instagram linkləri dəstəklənir' });
  }

  const shortcode = extractShortcode(url);
  if (!shortcode) {
    return res.status(400).json({ success: false, error: 'Instagram linki düzgün formatda deyil' });
  }

  const cleanedUrl = cleanUrl(shortcode);
  console.log(`\n══ Fetch: ${cleanedUrl} ══`);

  // Race all methods - return first successful result
  let result = null;
  let settled = false;

  await new Promise((resolve) => {
    // Only include methods whose domains resolve from this server
    const methodFns = [
      () => trySnapsave(cleanedUrl),     // snapsave.app ✓
      () => tryInstasave(cleanedUrl),    // instasave.website ✓
      () => tryFastdl(cleanedUrl),       // fastdl.app ✓
      () => tryAioDl(cleanedUrl),        // inflact.com, publer.com ✓
      () => tryEmbed(shortcode),         // instagram.com ✓
      () => tryYtDlp(cleanedUrl),        // yt-dlp local ✓ (slowest)
    ];

    let done = 0;
    const total = methodFns.length;

    // Global timeout - 25 seconds max
    const globalTimeout = setTimeout(() => {
      if (!settled) { settled = true; resolve(); }
    }, 25000);

    methodFns.forEach(fn => {
      fn().catch(() => null).then(r => {
        done++;
        if (r?.videoUrl && !result) {
          result = r;
          if (!settled) { settled = true; clearTimeout(globalTimeout); resolve(); }
        } else if (done >= total && !settled) {
          settled = true; clearTimeout(globalTimeout); resolve();
        }
      });
    });
  });

  if (!result?.videoUrl) {
    console.log('✗ All methods failed');
    return res.status(404).json({
      success: false,
      error: 'Video tapılmadı. Bu reel xüsusi hesaba aiddir və ya Instagram tərəfindən blok edilib. Linkin düzgün olduğunu yoxlayın.',
    });
  }

  console.log(`✓ Found via ${result.source}: ${result.videoUrl.slice(0, 60)}`);

  // Try to get thumbnail if missing
  let thumbnail = result.thumbnail || null;
  if (!thumbnail) {
    try {
      const oembed = await axios.get(
        `https://api.instagram.com/oembed/?url=${encodeURIComponent(cleanedUrl)}`,
        { headers: { 'User-Agent': MOBILE_UA }, timeout: 5000 }
      );
      thumbnail = oembed.data?.thumbnail_url || null;
    } catch {}
  }

  return res.json({
    success: true,
    videoUrl: result.videoUrl,
    thumbnail,
    title: result.title || 'Instagram Video',
    shortcode,
    source: result.source,
  });
});

// ─── /api/stream ──────────────────────────────────────────────
app.get('/api/stream', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL tələb olunur' });

  try {
    const decodedUrl = decodeURIComponent(url);
    const fname = (filename || `instagram_video_${Date.now()}.mp4`).replace(/[^\w\-_.]/g, '_');

    const response = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': MOBILE_UA,
        'Referer': 'https://www.instagram.com/',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        ...(req.headers.range ? { 'Range': req.headers.range } : {}),
      },
      timeout: 120000,
      maxRedirects: 10,
    });

    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    if (response.headers['content-length']) headers['Content-Length'] = response.headers['content-length'];
    if (response.headers['content-range']) headers['Content-Range'] = response.headers['content-range'];

    res.writeHead(response.status === 206 ? 206 : 200, headers);
    response.data.pipe(res);

    req.on('close', () => response.data.destroy());
    response.data.on('error', err => console.error('Stream error:', err.message));

  } catch (error) {
    console.error('Proxy error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ─── /api/thumb ───────────────────────────────────────────────
app.get('/api/thumb', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const resp = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      responseType: 'stream',
      headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.instagram.com/' },
      timeout: 15000,
    });
    res.set('Content-Type', resp.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    resp.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
http.createServer(app).listen(PORT, () => {
  console.log(`🚀 InstaDown running on port ${PORT}`);
});

process.on('uncaughtException', err => console.error('Uncaught:', err));
process.on('unhandledRejection', r => console.error('Rejection:', r));

module.exports = app;
