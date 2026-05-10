/**
 * Figma Site Analyzer — Headless Server v2.0
 * Screenshot full-page + extraction positions absolues
 */

const express   = require('express');
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

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
  res.json({ status: 'ok', service: 'Figma Site Analyzer', version: '2.0.0' });
});

app.post('/analyze', async (req, res) => {
  const { url, viewport_width = 1440 } = req.body;

  if (!url) return res.status(400).json({ success: false, message: 'URL manquante.' });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
      return res.status(400).json({ success: false, message: 'URL invalide.' });
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blocked.includes(parsed.hostname))
      return res.status(400).json({ success: false, message: 'URL non autorisée.' });
  } catch {
    return res.status(400).json({ success: false, message: 'URL malformée.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: parseInt(viewport_width), height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Essaie networkidle2, fallback sur domcontentloaded si timeout
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    } catch(e) {
      console.log('[Analyzer] networkidle2 timeout, fallback domcontentloaded');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000)); // attend 2s de plus
    }

    // Scroll pour déclencher lazy load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 500);
          total += 500;
          if (total >= Math.min(document.body.scrollHeight, 8000)) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 800));

    // Dimensions de la page
    const pageMetrics = await page.evaluate(() => ({
      width:  Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      height: Math.min(document.body.scrollHeight, 8000), // limite 8000px
    }));

    // Screenshot en base64
    const screenshotBuffer = await page.screenshot({
      fullPage: false, // viewport seulement pour éviter les timeouts
      encoding: 'base64',
      type: 'png',
    });

    // Extraction de tous les éléments visibles avec positions absolues
    const elements = await page.evaluate(() => {

      function rgbToHex(rgb) {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return null;
        const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
      }

      function isVisible(el, s) {
        if (!s) s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function getRect(el) {
        const r = el.getBoundingClientRect();
        return {
          x:      Math.round(r.left + window.scrollX),
          y:      Math.round(r.top  + window.scrollY),
          width:  Math.round(r.width),
          height: Math.round(r.height),
        };
      }

      function getElementData(el) {
        const s    = getComputedStyle(el);
        const rect = getRect(el);
        const tag  = el.tagName.toLowerCase();
        const cls  = (el.className || '').toString().substring(0, 150);
        const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
          ? el.textContent.trim()
          : '';

        return {
          tag, cls, text, rect,
          style: {
            'background-color': s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? s.backgroundColor : null,
            'color':            s.color,
            'font-size':        s.fontSize,
            'font-family':      s.fontFamily.split(',')[0].trim().replace(/['"]/g,''),
            'font-weight':      s.fontWeight,
            'border-radius':    s.borderRadius !== '0px' ? s.borderRadius : null,
            'border':           s.borderWidth !== '0px' ? s.border : null,
            'box-shadow':       s.boxShadow !== 'none' ? s.boxShadow : null,
            'padding-top':      s.paddingTop,
            'padding-right':    s.paddingRight,
            'padding-bottom':   s.paddingBottom,
            'padding-left':     s.paddingLeft,
            'opacity':          s.opacity !== '1' ? s.opacity : null,
            'text-transform':   s.textTransform !== 'none' ? s.textTransform : null,
            'letter-spacing':   s.letterSpacing !== 'normal' ? s.letterSpacing : null,
            'line-height':      s.lineHeight,
          },
        };
      }

      // ── Boutons — detection par styles computés (pas par classes CSS) ──
      const buttons = [];
      const seenBtn = new Set();

      // 1. Candidats explicites (button, input, role=button)
      const explicitBtns = [
        ...document.querySelectorAll('button'),
        ...document.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]'),
        ...document.querySelectorAll('[role="button"]'),
      ];

      // 2. Liens et divs qui RESSEMBLENT visuellement à des boutons
      // Critères : cursor pointer + background non transparent + padding + texte court
      const allClickable = [...document.querySelectorAll('a, div, span')].filter(el => {
        const s = getComputedStyle(el);
        if (s.cursor !== 'pointer') return false;
        if (s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent') return false;
        const pt = parseFloat(s.paddingTop), pb = parseFloat(s.paddingBottom);
        const pl = parseFloat(s.paddingLeft), pr = parseFloat(s.paddingRight);
        if ((pt + pb) < 4 || (pl + pr) < 8) return false;
        const text = el.textContent?.trim().replace(/\s+/g, ' ') || '';
        if (!text || text.length > 60 || text.length < 2) return false;
        // Doit avoir une taille raisonnable de bouton
        const rect = el.getBoundingClientRect();
        if (rect.height < 24 || rect.height > 120) return false;
        if (rect.width < 40 || rect.width > 500) return false;
        return true;
      });

      const allCandidates = [...explicitBtns, ...allClickable];

      for (const el of allCandidates) {
        const s = getComputedStyle(el);
        if (!isVisible(el, s)) continue;
        const rect = getRect(el);
        if (rect.width < 20 || rect.height < 10) continue;

        let text = el.textContent?.trim().replace(/\s+/g, ' ') || el.value?.trim() || el.getAttribute('aria-label') || '';
        if (!text || text.length > 80) continue;

        // Déduplique par texte + taille (captures les mêmes boutons répétés)
        const bg = s.backgroundColor;
        const key = text.substring(0, 20) + '|' + Math.round(rect.height / 10) + '|' + bg;
        if (seenBtn.has(key)) continue;
        seenBtn.add(key);

        // Score de priorité CTA : bouton coloré avec texte court = score élevé
        const isPrimary = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)';
        const isShortText = text.length < 30;
        const hasRadius = parseFloat(s.borderRadius) > 0;
        const score = (isPrimary ? 3 : 0) + (isShortText ? 2 : 0) + (hasRadius ? 1 : 0);

        const data = getElementData(el);
        data.text = text;
        data.score = score;
        buttons.push(data);
      }

      // Trie par score décroissant (meilleurs CTA en premier)
      buttons.sort((a, b) => (b.score || 0) - (a.score || 0));
      const topButtons = buttons.slice(0, 25);

      // ── Cards ─────────────────────────────────────────────────
      const cards = [];
      const seenCard = new Set();
      const allEls = [...document.querySelectorAll('*')];

      for (const el of allEls) {
        const cls = (el.className || '').toString();
        if (!/card|tile|panel/i.test(cls)) continue;

        const s = getComputedStyle(el);
        if (!isVisible(el, s)) continue;
        const rect = getRect(el);
        if (rect.width < 80 || rect.height < 60) continue;

        const key = cls.split(' ').slice(0,3).join('|');
        if (seenCard.has(key)) continue;
        seenCard.add(key);

        const data = getElementData(el);
        data.has_image = !!el.querySelector('img');
        data.headings  = [...el.querySelectorAll('h1,h2,h3,h4')]
          .map(h => h.textContent?.trim())
          .filter(t => t && t.length < 100)
          .slice(0, 3);

        cards.push(data);
        if (cards.length >= 15) break;
      }

      // ── Couleurs ──────────────────────────────────────────────
      const colorCounts = {};
      document.querySelectorAll('*').forEach(el => {
        if (!isVisible(el)) return;
        const s = getComputedStyle(el);
        [s.backgroundColor, s.color].forEach(v => {
          if (!v || v === 'rgba(0, 0, 0, 0)') return;
          const hex = rgbToHex(v);
          if (!hex || hex === '#000000' || hex === '#ffffff') return;
          colorCounts[hex] = (colorCounts[hex] || 0) + 1;
        });
      });
      const colors = Object.entries(colorCounts)
        .sort((a,b) => b[1]-a[1])
        .slice(0, 12)
        .map(([hex, count]) => ({ hex, count }));

      // ── Typographie ───────────────────────────────────────────
      const fonts = new Set();
      const sizes = {};
      const weights = new Set();
      document.querySelectorAll('h1,h2,h3,h4,p,a,button,span').forEach(el => {
        if (!isVisible(el)) return;
        const s = getComputedStyle(el);
        const font = s.fontFamily.split(',')[0].trim().replace(/['"]/g,'');
        if (font && font.length > 1 && font.length < 60 && !font.startsWith('-apple')) fonts.add(font);
        const size = s.fontSize;
        if (size?.endsWith('px')) {
          const px = parseFloat(size);
          if (px >= 10 && px <= 120) sizes[size] = (sizes[size]||0)+1;
        }
        if (s.fontWeight && s.fontWeight !== '400') weights.add(s.fontWeight);
      });

      // ── Icons SVG ─────────────────────────────────────────────
      const icons = [];
      const seenSvg = new Set();
      for (const svg of document.querySelectorAll('svg')) {
        if (!isVisible(svg)) continue;
        const rect = svg.getBoundingClientRect();
        if (rect.width < 8 || rect.width > 80 || rect.height < 8 || rect.height > 80) continue;
        const svgKey = svg.innerHTML.trim().substring(0, 80);
        if (seenSvg.has(svgKey)) continue;
        seenSvg.add(svgKey);
        const label = svg.getAttribute('aria-label')
          || (svg.closest('button') && svg.closest('button').textContent.trim())
          || (svg.closest('a') && svg.closest('a').textContent.trim())
          || '';
        icons.push({
          label: label.substring(0, 50),
          svg:   svg.outerHTML,
          rect:  { width: Math.round(rect.width), height: Math.round(rect.height) },
        });
        if (icons.length >= 30) break;
      }

      return {
        buttons: topButtons,
        cards,
        colors,
        icons,
        typography: {
          fonts:   [...fonts].slice(0,6),
          sizes:   Object.entries(sizes).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([s])=>s),
          weights: [...weights].slice(0,6),
        },
      };

    });

    await browser.close();

    res.json({
      success: true,
      data: {
        url,
        screenshot:   screenshotBuffer,  // base64 PNG
        page_width:   pageMetrics.width,
        page_height:  pageMetrics.height,
        viewport_width: parseInt(viewport_width),
        elements,
      },
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[Analyzer] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

const server = app.listen(PORT, () => console.log(`[Analyzer] v2.0 running on port ${PORT}`));
server.timeout = 90000; // 90s timeout HTTP
