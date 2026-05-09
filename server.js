/**
 * Figma Site Analyzer — Headless Server v1.1
 * Node.js + Puppeteer + Express
 */

const express   = require('express');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Figma Site Analyzer', version: '1.1.0' });
});

app.post('/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ success: false, message: 'URL manquante.' });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success: false, message: 'URL invalide.' });
    }
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blocked.includes(parsed.hostname)) {
      return res.status(400).json({ success: false, message: 'URL non autorisée.' });
    }
  } catch {
    return res.status(400).json({ success: false, message: 'URL malformée.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    // Scroll pour déclencher le lazy load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= Math.min(document.body.scrollHeight, 6000)) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 500));

    const result = await page.evaluate(() => {

      function rgbToHex(rgb) {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return null;
        const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        if (r === 255 && g === 255 && b === 255) return null;
        if (r === 0 && g === 0 && b === 0) return null;
        return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
      }

      function getStyles(el) {
        const s = getComputedStyle(el);
        const clean = {};
        const pairs = {
          'background-color': s.backgroundColor,
          'color':            s.color,
          'font-size':        s.fontSize,
          'font-family':      s.fontFamily.split(',')[0].trim().replace(/['"]/g,''),
          'font-weight':      s.fontWeight,
          'border-radius':    s.borderRadius,
          'padding-top':      s.paddingTop,
          'padding-right':    s.paddingRight,
          'padding-bottom':   s.paddingBottom,
          'padding-left':     s.paddingLeft,
          'border':           s.border,
          'box-shadow':       s.boxShadow !== 'none' ? s.boxShadow : null,
          'letter-spacing':   s.letterSpacing !== 'normal' ? s.letterSpacing : null,
          'text-transform':   s.textTransform !== 'none' ? s.textTransform : null,
          'width':            s.width,
          'height':           s.height,
        };
        const skip = ['rgba(0, 0, 0, 0)','transparent','none','normal','0px','auto','initial','inherit',''];
        for (const [k,v] of Object.entries(pairs)) {
          if (!v || skip.includes(v)) continue;
          if (k === 'font-family' && v.length > 60) continue;
          clean[k] = v;
        }
        return clean;
      }

      function isVisible(el) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      // ── Couleurs ─────────────────────────────────────────────────
      function extractColors() {
        const counts = {};
        document.querySelectorAll('*').forEach(el => {
          if (!isVisible(el)) return;
          const s = getComputedStyle(el);
          [s.backgroundColor, s.color].forEach(v => {
            const hex = rgbToHex(v);
            if (hex) counts[hex] = (counts[hex] || 0) + 1;
          });
        });
        return Object.entries(counts)
          .sort((a,b) => b[1]-a[1])
          .slice(0, 10)
          .map(([hex, count]) => ({ hex, count }));
      }

      // ── Boutons ──────────────────────────────────────────────────
      function extractButtons() {
        const results = [];
        const seen    = new Set();

        const candidates = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('a[class*="btn"], a[class*="button"], a[class*="cta"]'),
          ...document.querySelectorAll('[role="button"]'),
          ...document.querySelectorAll('input[type="submit"], input[type="button"]'),
          ...document.querySelectorAll('[class*="btn-"], [class*="-btn"], [class*="button-"]'),
        ];

        for (const el of candidates) {
          if (!isVisible(el)) continue;

          let text = el.textContent?.trim().replace(/\s+/g,' ') || el.value?.trim() || el.getAttribute('aria-label') || '';
          if (!text || text.length > 80) continue;

          const cls = (el.className || '').toString();
          const key = cls.split(' ')[0] + '|' + el.tagName;
          if (seen.has(key)) continue;
          seen.add(key);

          // Exclut les boutons de navigation sans style CTA
          const inNav = el.closest('nav, [role="navigation"]');
          const hasCta = /btn|button|cta/i.test(cls);
          if (inNav && !hasCta) continue;

          const style = getStyles(el);
          const rect  = el.getBoundingClientRect();

          results.push({
            text,
            tag:   el.tagName.toLowerCase(),
            class: cls.substring(0, 200),
            style,
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
          });

          if (results.length >= 20) break;
        }
        return results;
      }

      // ── Cards ─────────────────────────────────────────────────────
      function extractCards() {
        const results = [];
        const seen    = new Set();

        const all = [...document.querySelectorAll('*')].filter(el => {
          const cls = (el.className || '').toString();
          return /card|tile|panel/i.test(cls);
        });

        for (const el of all) {
          if (!isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 80 || rect.height < 80) continue;

          const cls = (el.className || '').toString();
          const key = cls.split(' ').slice(0,3).join('|');
          if (seen.has(key)) continue;
          seen.add(key);

          const headings = [...el.querySelectorAll('h1,h2,h3,h4')]
            .map(h => h.textContent?.trim())
            .filter(t => t && t.length < 100)
            .slice(0, 3);

          results.push({
            tag:       el.tagName.toLowerCase(),
            class:     cls.substring(0, 200),
            style:     getStyles(el),
            has_image: !!el.querySelector('img'),
            headings,
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
          });

          if (results.length >= 15) break;
        }
        return results;
      }

      // ── Typographie ───────────────────────────────────────────────
      function extractTypography() {
        const fonts   = new Set();
        const sizes   = {};
        const weights = new Set();

        document.querySelectorAll('h1,h2,h3,h4,p,a,button').forEach(el => {
          if (!isVisible(el)) return;
          const s = getComputedStyle(el);

          const font = s.fontFamily.split(',')[0].trim().replace(/['"]/g,'');
          if (font && font.length > 1 && font.length < 60 && !font.startsWith('-apple')) fonts.add(font);

          const size = s.fontSize;
          if (size?.endsWith('px')) {
            const px = parseFloat(size);
            if (px >= 10 && px <= 120) sizes[size] = (sizes[size] || 0) + 1;
          }

          if (s.fontWeight && s.fontWeight !== '400') weights.add(s.fontWeight);
        });

        return {
          fonts:   [...fonts].slice(0, 6),
          sizes:   Object.entries(sizes).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([s])=>s),
          weights: [...weights].slice(0, 6),
        };
      }

      return {
        buttons:    extractButtons(),
        cards:      extractCards(),
        colors:     extractColors(),
        typography: extractTypography(),
      };
    });

    await browser.close();
    res.json({ success: true, data: { url, elements: result } });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[Analyzer] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => console.log(`[Analyzer] Running on port ${PORT}`));
