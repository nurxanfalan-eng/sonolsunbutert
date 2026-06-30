const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instagram Graph API / oEmbed fallback headers
const INSTAGRAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
};

// Extract shortcode from Instagram URL
function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/stories\/[^/]+\/([A-Za-z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Clean Instagram URL
function cleanUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// Method 1: Try Instagram's embed API
async function tryEmbedAPI(shortcode) {
  try {
    const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    const resp = await axios.get(url, {
      headers: {
        ...INSTAGRAM_HEADERS,
        'Referer': 'https://www.instagram.com/',
      },
      timeout: 15000,
    });
    const html = resp.data;
    
    // Try to find video URL in embed HTML
    const videoPatterns = [
      /video_url":"([^"]+)"/,
      /"contentUrl":"([^"]+)"/,
      /src="(https:\/\/[^"]*\.mp4[^"]*)"/,
      /videoSrc="([^"]+)"/,
    ];
    
    for (const pat of videoPatterns) {
      const m = html.match(pat);
      if (m) {
        return decodeURIComponent(m[1].replace(/\\u0026/g, '&').replace(/\\/g, ''));
      }
    }
  } catch (e) {
    console.log('Embed API failed:', e.message);
  }
  return null;
}

// Method 2: Try Instagram oEmbed API  
async function tryOEmbed(postUrl) {
  try {
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(postUrl)}&fields=thumbnail_url,title,media_type&access_token=&format=json`;
    // Try without token first
    const cleanedUrl = cleanUrl(postUrl);
    const resp = await axios.get(`https://api.instagram.com/oembed/?url=${encodeURIComponent(cleanedUrl)}`, {
      headers: INSTAGRAM_HEADERS,
      timeout: 10000,
    });
    return resp.data;
  } catch (e) {
    console.log('oEmbed failed:', e.message);
  }
  return null;
}

// Method 3: Scrape Instagram page directly
async function scrapeInstagram(postUrl) {
  try {
    const cleanedUrl = cleanUrl(postUrl);
    const resp = await axios.get(cleanedUrl, {
      headers: INSTAGRAM_HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });
    const html = resp.data;
    
    // Multiple patterns to extract video URL from page source
    const videoPatterns = [
      /"video_url"\s*:\s*"([^"]+)"/g,
      /video_url":"([^"]+)"/g,
      /"contentUrl"\s*:\s*"([^"]+)"/g,
      /"playbackUrl"\s*:\s*"([^"]+)"/g,
      /src="(https:\/\/scontent[^"]*\.mp4[^"]*)"/g,
      /"url"\s*:\s*"(https:\/\/[^"]*instagram[^"]*\.mp4[^"]*)"/g,
    ];
    
    let videoUrl = null;
    
    for (const pat of videoPatterns) {
      pat.lastIndex = 0;
      const m = pat.exec(html);
      if (m) {
        videoUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
        if (videoUrl.includes('.mp4')) {
          break;
        }
      }
    }
    
    // Try to find thumbnail
    let thumbnail = null;
    const thumbPatterns = [
      /"display_url"\s*:\s*"([^"]+)"/,
      /property="og:image"\s+content="([^"]+)"/,
      /"thumbnail_src"\s*:\s*"([^"]+)"/,
    ];
    for (const pat of thumbPatterns) {
      const m = html.match(pat);
      if (m) {
        thumbnail = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
        break;
      }
    }

    // Try to extract title
    let title = 'Instagram Video';
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) title = titleMatch[1].replace(' • Instagram', '').trim();

    return { videoUrl, thumbnail, title };
  } catch (e) {
    console.log('Scrape failed:', e.message);
  }
  return null;
}

// Method 4: Use Instagram's GraphQL API
async function tryGraphQL(shortcode) {
  try {
    const url = `https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables={"shortcode":"${shortcode}"}`;
    const resp = await axios.get(url, {
      headers: {
        ...INSTAGRAM_HEADERS,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.instagram.com/p/${shortcode}/`,
      },
      timeout: 15000,
    });
    const data = resp.data;
    const media = data?.data?.shortcode_media;
    if (media?.video_url) {
      return {
        videoUrl: media.video_url,
        thumbnail: media.display_url,
        title: media.edge_media_to_caption?.edges?.[0]?.node?.text || 'Instagram Video',
      };
    }
  } catch (e) {
    console.log('GraphQL failed:', e.message);
  }
  return null;
}

// Method 5: Use third-party Instagram downloader APIs
async function tryThirdPartyAPI(postUrl) {
  const apis = [
    {
      name: 'saveinsta',
      url: 'https://v3.saveinsta.app/api/ajaxSearch',
      method: 'post',
      data: `q=${encodeURIComponent(postUrl)}&t=media&lang=en`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://saveinsta.app/',
        'Origin': 'https://saveinsta.app',
        'X-Requested-With': 'XMLHttpRequest',
      },
      parse: (data) => {
        if (data?.status === 'ok' && data?.data) {
          const html = data.data;
          const videoMatch = html.match(/href="(https:\/\/[^"]*\.mp4[^"]*)"[^>]*>/);
          if (videoMatch) return { videoUrl: videoMatch[1] };
        }
        return null;
      }
    },
    {
      name: 'snapsave',
      url: 'https://snapsave.app/action.php',
      method: 'post',
      data: `url=${encodeURIComponent(postUrl)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://snapsave.app/',
        'Origin': 'https://snapsave.app',
      },
      parse: (data) => {
        if (typeof data === 'string') {
          const videoMatch = data.match(/href="(https:\/\/[^"]*\.mp4[^"]*)"[^>]*>/);
          if (videoMatch) return { videoUrl: videoMatch[1] };
        }
        return null;
      }
    },
    {
      name: 'instasave',
      url: 'https://instasave.website/api/',
      method: 'post',
      data: JSON.stringify({ url: postUrl }),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://instasave.website/',
        'Origin': 'https://instasave.website',
      },
      parse: (data) => {
        if (data?.links?.[0]?.url) return { videoUrl: data.links[0].url };
        if (data?.url) return { videoUrl: data.url };
        return null;
      }
    },
    {
      name: 'ssdownloader',
      url: 'https://ssdownloader.com/api/',
      method: 'post',
      data: JSON.stringify({ url: postUrl }),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://ssdownloader.com/',
        'Origin': 'https://ssdownloader.com',
      },
      parse: (data) => {
        if (data?.data?.[0]?.url) return { videoUrl: data.data[0].url };
        return null;
      }
    }
  ];

  for (const api of apis) {
    try {
      console.log(`Trying ${api.name}...`);
      const resp = await axios({
        method: api.method,
        url: api.url,
        data: api.data,
        headers: {
          ...api.headers,
        },
        timeout: 15000,
        maxRedirects: 3,
      });
      const result = api.parse(resp.data);
      if (result?.videoUrl) {
        console.log(`${api.name} succeeded!`);
        return result;
      }
    } catch (e) {
      console.log(`${api.name} failed:`, e.message);
    }
  }
  return null;
}

// Method 6: Use RapidAPI Instagram downloader
async function tryRapidAPI(postUrl) {
  // Try multiple free Instagram APIs
  const endpoints = [
    `https://instagram-downloader-download-instagram-videos-stories.p.rapidapi.com/index?url=${encodeURIComponent(postUrl)}`,
    `https://instagram-bulk-profile-scrapper.p.rapidapi.com/clients/api/ig/ig_media_downloader?type=video&url=${encodeURIComponent(postUrl)}`,
  ];
  
  for (const endpoint of endpoints) {
    try {
      const resp = await axios.get(endpoint, {
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || '',
          'X-RapidAPI-Host': new URL(endpoint).hostname,
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 10000,
      });
      if (resp.data?.url || resp.data?.video_url) {
        return { videoUrl: resp.data.url || resp.data.video_url };
      }
    } catch (e) {
      console.log('RapidAPI failed:', e.message);
    }
  }
  return null;
}

// Main API endpoint - get video info
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL tələb olunur' });
  }

  // Validate Instagram URL
  if (!url.includes('instagram.com')) {
    return res.status(400).json({ success: false, error: 'Yalnız Instagram linkləri dəstəklənir' });
  }

  const shortcode = extractShortcode(url);
  if (!shortcode) {
    return res.status(400).json({ success: false, error: 'Instagram linki düzgün formatda deyil' });
  }

  console.log(`Processing: ${url}, shortcode: ${shortcode}`);

  let videoUrl = null;
  let thumbnail = null;
  let title = 'Instagram Video';

  // Try methods in order
  // Method 1: GraphQL
  const graphqlResult = await tryGraphQL(shortcode);
  if (graphqlResult?.videoUrl) {
    videoUrl = graphqlResult.videoUrl;
    thumbnail = graphqlResult.thumbnail;
    title = graphqlResult.title || title;
  }

  // Method 2: Embed API
  if (!videoUrl) {
    const embedUrl = await tryEmbedAPI(shortcode);
    if (embedUrl) videoUrl = embedUrl;
  }

  // Method 3: Direct scrape
  if (!videoUrl) {
    const scrapeResult = await scrapeInstagram(url);
    if (scrapeResult?.videoUrl) {
      videoUrl = scrapeResult.videoUrl;
      thumbnail = scrapeResult.thumbnail || thumbnail;
      title = scrapeResult.title || title;
    }
  }

  // Method 4: Third-party APIs
  if (!videoUrl) {
    const thirdPartyResult = await tryThirdPartyAPI(url);
    if (thirdPartyResult?.videoUrl) {
      videoUrl = thirdPartyResult.videoUrl;
    }
  }

  if (!videoUrl) {
    return res.status(404).json({ 
      success: false, 
      error: 'Video tapılmadı. Instagram müvəqqəti olaraq bu linki blok edib ola bilər. Bir az gözləyib yenidən cəhd edin.',
      shortcode 
    });
  }

  // Get thumbnail via oEmbed if not found
  if (!thumbnail) {
    try {
      const oembed = await tryOEmbed(url);
      if (oembed?.thumbnail_url) thumbnail = oembed.thumbnail_url;
    } catch (e) {}
  }

  return res.json({
    success: true,
    videoUrl,
    thumbnail,
    title,
    shortcode,
  });
});

// Proxy endpoint - stream video through server (avoids CORS)
app.get('/api/stream', async (req, res) => {
  const { url, filename } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL tələb olunur' });
  }

  try {
    const decodedUrl = decodeURIComponent(url);
    console.log('Streaming:', decodedUrl.substring(0, 100));
    
    const response = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Range': req.headers.range || 'bytes=0-',
      },
      timeout: 60000,
      maxRedirects: 10,
    });

    const contentType = response.headers['content-type'] || 'video/mp4';
    const contentLength = response.headers['content-length'];
    const contentRange = response.headers['content-range'];
    
    const fname = filename || `instagram_${Date.now()}.mp4`;
    
    const headers = {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };
    
    if (contentLength) headers['Content-Length'] = contentLength;
    if (contentRange) headers['Content-Range'] = contentRange;
    
    const statusCode = response.status === 206 ? 206 : 200;
    
    res.writeHead(statusCode, headers);
    response.data.pipe(res);
    
    response.data.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream xətası' });
      }
    });

  } catch (error) {
    console.error('Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Video stream xətası: ' + error.message });
    }
  }
});

// Thumbnail proxy (avoid CORS issues for images)
app.get('/api/thumb', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  try {
    const decodedUrl = decodeURIComponent(url);
    const resp = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.instagram.com/',
      },
      timeout: 15000,
    });

    const ct = resp.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=3600');
    resp.data.pipe(res);
  } catch (e) {
    res.status(404).end();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`🚀 Instagram Downloader running on port ${PORT}`);
  console.log(`📱 Open: http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

module.exports = app;
