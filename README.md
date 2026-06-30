# InstaDown – Instagram HD Video Endirici

## Haqqında
Instagram reels, post, stories videolarını HD keyfiyyətdə, logo/watermark olmadan endirmək üçün veb tətbiq.

## Xüsusiyyətlər
- ✅ HD keyfiyyət (orijinal kimi)
- 🚫 Logo/watermark yoxdur
- 📲 PWA – Ana ekrana əlavə etmək olur
- ⚡ Sürətli endirmə (server proxy ilə)
- 📱 Mobil uyğun dizayn

## Texnologiyalar
- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS + CSS (CDN-siz)
- **Deploy**: Render.com

## Quraşdırma
```bash
npm install
npm start
```

## API Endpoint-ləri
- `POST /api/fetch` – Video URL tap: `{ url: "instagram_url" }`
- `GET /api/stream?url=...&filename=...` – Video stream/endirmə
- `GET /api/thumb?url=...` – Thumbnail proxy
- `GET /health` – Server sağlamlıq yoxlaması

## Deploy (Render.com)
1. GitHub-a push et
2. Render.com-da "New Web Service" yarat
3. `npm start` start command-i ver
4. `PORT` env var avtomatik təyin olunur
