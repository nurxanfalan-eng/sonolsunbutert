#!/usr/bin/env python3
"""
Instagram video fetcher - uses multiple methods to find video URL
Returns JSON to stdout
"""
import sys
import json
import re
import ssl
import urllib.request
import urllib.parse
import urllib.error

def fetch_url(url, headers=None, data=None, timeout=15):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    default_headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
    }
    if headers:
        default_headers.update(headers)
    
    req = urllib.request.Request(url, data, default_headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read().decode('utf-8', errors='ignore'), resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        return body, e.code
    except Exception as e:
        return None, str(e)

def clean_url(url):
    try:
        from urllib.parse import urlparse, urlunparse
        p = urlparse(url)
        return urlunparse((p.scheme, p.netloc, p.path.rstrip('/') + '/', '', '', ''))
    except:
        return url

def decode_url(url):
    return url.replace('\\u0026', '&').replace('\\/', '/').replace('\\', '')

def try_method1_instasave(post_url):
    """instasave.website API"""
    try:
        data = json.dumps({"url": post_url}).encode()
        body, status = fetch_url(
            'https://instasave.website/api/',
            headers={
                'Content-Type': 'application/json',
                'Referer': 'https://instasave.website/',
                'Origin': 'https://instasave.website',
            },
            data=data,
            timeout=12,
        )
        if body and status == 200:
            d = json.loads(body)
            vurl = None
            if isinstance(d, list) and d:
                vurl = d[0].get('url') or d[0].get('downloadUrl')
            elif isinstance(d, dict):
                vurl = d.get('url') or (d.get('links', [{}])[0].get('url') if d.get('links') else None)
            if vurl:
                return {'videoUrl': decode_url(vurl), 'source': 'instasave'}
    except Exception as e:
        pass
    return None

def try_method2_saveig(post_url):
    """saveig.me API"""
    try:
        data = urllib.parse.urlencode({'q': post_url, 't': 'media', 'lang': 'en'}).encode()
        body, status = fetch_url(
            'https://v2.saveig.me/api/ajaxSearch',
            headers={
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Referer': 'https://saveig.me/',
                'Origin': 'https://saveig.me',
                'X-Requested-With': 'XMLHttpRequest',
            },
            data=data,
            timeout=12,
        )
        if body and status == 200:
            try:
                d = json.loads(body)
                if d.get('status') == 'ok':
                    html = d.get('data', '')
                    m = re.search(r'href="(https://[^"]*\.mp4[^"]*)"', html)
                    if m:
                        return {'videoUrl': m.group(1).replace('&amp;', '&'), 'source': 'saveig'}
            except:
                pass
    except:
        pass
    return None

def try_method3_igram(post_url):
    """igram.world"""
    try:
        # First get page to extract token
        body, status = fetch_url(
            'https://igram.world/',
            headers={'Accept': 'text/html'},
            timeout=10,
        )
        if not body:
            return None
        
        token_m = re.search(r'name="_token"\s+value="([^"]+)"', body)
        token = token_m.group(1) if token_m else ''
        
        data = urllib.parse.urlencode({
            'url': post_url,
            'download_type': '',
            '_token': token,
        }).encode()
        
        body2, status2 = fetch_url(
            'https://igram.world/',
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://igram.world/',
                'Origin': 'https://igram.world',
                'X-Requested-With': 'XMLHttpRequest',
            },
            data=data,
            timeout=15,
        )
        if body2:
            html = body2
            m = re.search(r'"(https://[^"]*cdn[^"]*\.mp4[^"]*)"', html)
            if m:
                return {'videoUrl': m.group(1).replace('\\/', '/').replace('&amp;', '&'), 'source': 'igram'}
            # Try to find in href
            m2 = re.search(r'href="(https://[^"]+\.mp4[^"]*)"', html)
            if m2:
                return {'videoUrl': m2.group(1).replace('&amp;', '&'), 'source': 'igram-href'}
    except Exception as e:
        pass
    return None

def try_method4_reelsaver(post_url):
    """reelsaver.net"""
    try:
        data = urllib.parse.urlencode({'postLink': post_url}).encode()
        body, status = fetch_url(
            'https://reelsaver.net/wp-json/aio-dl/video-data/',
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://reelsaver.net/',
                'Origin': 'https://reelsaver.net',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            data=data,
            timeout=15,
        )
        if body and status == 200:
            d = json.loads(body)
            medias = d.get('medias', [])
            for m in medias:
                if 'mp4' in m.get('url', '').lower() or m.get('extension') == 'mp4':
                    return {'videoUrl': m['url'], 'thumbnail': d.get('thumbnail'), 'title': d.get('title'), 'source': 'reelsaver'}
            if d.get('url'):
                return {'videoUrl': d['url'], 'source': 'reelsaver'}
    except:
        pass
    return None

def try_method5_yt_dlp_cookies(post_url):
    """yt-dlp with anonymous session"""
    import subprocess
    try:
        result = subprocess.run([
            'yt-dlp',
            '--no-playlist',
            '--no-warnings',
            '--print', 'url',
            '--print', 'thumbnail',
            '--print', 'title',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--no-check-certificates',
            '--extractor-args', 'instagram:api=1',
            '--socket-timeout', '20',
            post_url,
        ], capture_output=True, text=True, timeout=35)
        
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split('\n')
            video_url = lines[0].strip() if lines else None
            thumbnail = lines[1].strip() if len(lines) > 1 else None
            title = lines[2].strip() if len(lines) > 2 else 'Instagram Video'
            if video_url and video_url.startswith('http'):
                return {'videoUrl': video_url, 'thumbnail': thumbnail, 'title': title, 'source': 'yt-dlp'}
    except:
        pass
    return None

def try_method6_fastdl(post_url):
    """fastdl.app API"""
    try:
        data = json.dumps({'url': post_url}).encode()
        body, status = fetch_url(
            'https://fastdl.app/api/convert',
            headers={
                'Content-Type': 'application/json',
                'Referer': 'https://fastdl.app/',
                'Origin': 'https://fastdl.app',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            data=data,
            timeout=15,
        )
        if body and status == 200:
            d = json.loads(body)
            if d.get('success') or d.get('status') == 'ok':
                # Find video URL in response
                all_urls = re.findall(r'https://[^\s"\'<>]+\.mp4[^\s"\'<>]*', body)
                if all_urls:
                    return {'videoUrl': all_urls[0].replace('&amp;', '&'), 'source': 'fastdl'}
                if d.get('url'):
                    return {'videoUrl': d['url'], 'source': 'fastdl'}
                if d.get('links'):
                    links = d['links']
                    if isinstance(links, list) and links:
                        return {'videoUrl': links[0].get('url', links[0]) if isinstance(links[0], dict) else links[0], 'source': 'fastdl'}
    except:
        pass
    return None

def try_method7_inflact(post_url):
    """inflact.com downloader"""
    try:
        data = urllib.parse.urlencode({'url': post_url}).encode()
        body, status = fetch_url(
            'https://inflact.com/downloader/instagram/',
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://inflact.com/downloader/instagram/',
                'Origin': 'https://inflact.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'X-Requested-With': 'XMLHttpRequest',
            },
            data=data,
            timeout=15,
        )
        if body:
            m = re.search(r'href="(https://[^"]*\.mp4[^"]*)"', body)
            if m:
                return {'videoUrl': m.group(1).replace('&amp;', '&'), 'source': 'inflact'}
            # Try JSON parse
            try:
                d = json.loads(body)
                vurl = d.get('url') or d.get('video_url') or d.get('downloadUrl')
                if vurl:
                    return {'videoUrl': vurl, 'source': 'inflact'}
            except:
                pass
    except:
        pass
    return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'URL required'}))
        sys.exit(1)
    
    post_url = sys.argv[1]
    shortcode_m = re.search(r'instagram\.com/(?:reel|p|tv)/([A-Za-z0-9_-]+)', post_url)
    if not shortcode_m:
        print(json.dumps({'error': 'Invalid Instagram URL'}))
        sys.exit(1)
    
    clean = 'https://www.instagram.com/reel/' + shortcode_m.group(1) + '/'
    
    methods = [
        ('reelsaver', try_method4_reelsaver),
        ('instasave', try_method1_instasave),
        ('saveig', try_method2_saveig),
        ('fastdl', try_method6_fastdl),
        ('igram', try_method3_igram),
        ('inflact', try_method7_inflact),
        ('yt-dlp', try_method5_yt_dlp_cookies),
    ]
    
    for name, method in methods:
        try:
            result = method(clean)
            if result and result.get('videoUrl'):
                result['success'] = True
                print(json.dumps(result))
                sys.exit(0)
        except:
            pass
    
    print(json.dumps({
        'success': False,
        'error': 'Video tapilmadi - butun metodlar ugursuz oldu'
    }))
    sys.exit(1)

if __name__ == '__main__':
    main()
