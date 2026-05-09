/**
 * Figma Site Analyzer — Headless Server
 * Node.js + Playwright + Express
 *
 * Reçoit une URL, charge la page avec un vrai Chrome,
 * extrait les styles computés réels de chaque élément visible,
 * retourne un JSON propre.
 */

const express    = require('express');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — autorise ton WordPress et le plugin Figma
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Figma Site Analyzer', version: '1.0.0' });
});

// ── Endpoint principal ──────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, message: 'URL manquante.' });
  }

  // Validation URL basique
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success: false, message: 'URL invalide.' });
    }
    // Anti-SSRF
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blocked.includes(parsed.hostname)) {
      return res.status(400).json({ success: false, message: 'URL non autorisée.' });
    }
  } catch {
    return res.status(400).json({ success: false, message: 'URL malformée.' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Viewport desktop
    await page.setViewportSize({ width: 1440, height: 900 });

    // User agent réaliste
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // Charge la page — attend que le réseau soit calme
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 25000,
    });

    // Scroll pour déclencher le lazy load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance  = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= Math.min(document.body.scrollHeight, 6000)) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });

    // Revient en haut
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // ── Extraction dans le contexte du navigateur ───────────────
    const result = await page.evaluate(() => {

      // Couleurs : lit uniquement les éléments VISIBLES dans le viewport étendu
      function extractColors() {
        const colors = {};
        const elements = document.querySelectorAll('*');

        elements.forEach(el => {
          const rect = el.getBoundingClientRect();
          // Ignore les éléments hors écran ou invisibles
          if (rect.width === 0 || rect.height === 0) return;
          if (getComputedStyle(el).display === 'none') return;
          if (getComputedStyle(el).visibility === 'hidden') return;

          const style = getComputedStyle(el);
          const props = [
            style.backgroundColor,
            style.color,
            style.borderColor,
            style.outlineColor,
          ];

          props.forEach(val => {
            if (!val || val === 'transparent' || val === 'rgba(0, 0, 0, 0)') return;
            // Convertit rgb(r,g,b) → hex
            const m = val.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return;
            const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
            if (r === 255 && g === 255 && b === 255) return; // blanc
            if (r === 0   && g === 0   && b === 0)   return; // noir pur
            const hex = '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
            colors[hex] = (colors[hex] || 0) + 1;
          });
        });

        // Trie par fréquence, garde les 12 plus utilisées
        return Object.entries(colors)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([hex, count]) => ({ hex, count }));
      }

      // Styles computés d'un élément → objet propre
      function getElementStyles(el) {
        const s = getComputedStyle(el);
        return {
          'background-color': s.backgroundColor,
          'color':            s.color,
          'font-size':        s.fontSize,
          'font-family':      s.fontFamily.split(',')[0].trim().replace(/['"]/g, ''),
          'font-weight':      s.fontWeight,
          'border-radius':    s.borderRadius,
          'padding':          s.padding,
          'padding-top':      s.paddingTop,
          'padding-right':    s.paddingRight,
          'padding-bottom':   s.paddingBottom,
          'padding-left':     s.paddingLeft,
          'border':           s.border,
          'box-shadow':       s.boxShadow,
          'letter-spacing':   s.letterSpacing,
          'text-transform':   s.textTransform,
          'width':            s.width,
          'height':           s.height,
          'display':          s.display,
          'gap':              s.gap,
        };
      }

      // Filtre les valeurs vides / transparentes / par défaut
      function cleanStyles(styles) {
        const clean = {};
        const skip = [
          'rgba(0, 0, 0, 0)', 'transparent', 'none', 'normal',
          '0px', 'auto', 'rgb(0, 0, 0)', 'initial', 'inherit',
        ];
        for (const [k, v] of Object.entries(styles)) {
          if (!v || skip.includes(v)) continue;
          if (v === '0px 0px 0px 0px') continue;  // padding vide
          if (k === 'font-family' && v.length > 60) continue;
          clean[k] = v;
        }
        return clean;
      }

      // ── Boutons ─────────────────────────────────────────────────
      function extractButtons() {
        const buttons  = [];
        const seenKey  = new Set();

        // Tous les éléments interactifs potentiellement des boutons CTA
        const candidates = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('a[class*="btn"], a[class*="button"], a[class*="cta"]'),
          ...document.querySelectorAll('[role="button"]'),
          ...document.querySelectorAll('input[type="submit"], input[type="button"]'),
        ];

        for (const el of candidates) {
          // Doit être visible
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          // Texte
          let text = el.textContent?.trim() || el.value?.trim() || el.getAttribute('aria-label') || '';
          text = text.replace(/\s+/g, ' ').trim();
          if (!text || text.length > 80) continue;

          // Déduplique par classe principale
          const mainClass = (el.className || '').toString().split(' ')[0];
          const key = mainClass + '|' + el.tagName;
          if (seenKey.has(key)) continue;
          seenKey.add(key);

          // Exclut les boutons de navigation répétitifs (dans nav, menu hamburger, etc.)
          const inNav = el.closest('nav, [role="navigation"]');
          const inMenu = el.closest('[class*="menu"], [class*="dropdown"]');
          // Garde quand même les boutons CTA dans la nav (ex: "Get started")
          const isCta = /btn|button|cta/i.test(el.className);
          if ((inNav || inMenu) && !isCta) continue;

          const rawStyles  = getElementStyles(el);
          const cleanStyle = cleanStyles(rawStyles);

          buttons.push({
            text,
            tag:   el.tagName.toLowerCase(),
            class: (el.className || '').toString().substring(0, 200),
            style: cleanStyle,
            rect: {
              width:  Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });

          if (buttons.length >= 20) break;
        }

        return buttons;
      }

      // ── Cards ────────────────────────────────────────────────────
      function extractCards() {
        const cards   = [];
        const seenKey = new Set();

        // Sélecte tout élément dont une classe contient "card"
        const allEls = document.querySelectorAll('*');
        const cardEls = [...allEls].filter(el => {
          const cls = (el.className || '').toString();
          return /card|tile|panel/i.test(cls);
        });

        for (const el of cardEls) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 50) continue; // trop petit

          const cls = (el.className || '').toString();
          const key = cls.split(' ').slice(0, 3).join('|'); // clé sur les 3 premières classes
          if (seenKey.has(key)) continue;
          seenKey.add(key);

          const rawStyles  = getElementStyles(el);
          const cleanStyle = cleanStyles(rawStyles);

          // Titres enfants
          const headings = [...el.querySelectorAll('h1,h2,h3,h4')]
            .map(h => h.textContent?.trim())
            .filter(t => t && t.length < 100)
            .slice(0, 3);

          cards.push({
            tag:       el.tagName.toLowerCase(),
            class:     cls.substring(0, 200),
            style:     cleanStyle,
            has_image: !!el.querySelector('img'),
            headings,
            rect: {
              width:  Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });

          if (cards.length >= 15) break;
        }

        return cards;
      }

      // ── Typographie ──────────────────────────────────────────────
      function extractTypography() {
        const fonts   = new Set();
        const sizes   = {};
        const weights = new Set();

        const headings = document.querySelectorAll('h1, h2, h3, h4, p, a, button, span');
        headings.forEach(el => {
          const s = getComputedStyle(el);
          if (s.display === 'none') return;

          // Font family — première font de la stack, sans quotes
          const font = s.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
          if (font && font.length > 1 && font.length < 60 && !font.startsWith('-apple')) {
            fonts.add(font);
          }

          // Font size — seulement les valeurs concrètes en px
          const size = s.fontSize;
          if (size && size.endsWith('px')) {
            const px = parseFloat(size);
            if (px >= 10 && px <= 120) {
              sizes[size] = (sizes[size] || 0) + 1;
            }
          }

          // Font weight
          const weight = s.fontWeight;
          if (weight && weight !== '400') weights.add(weight);
        });

        // Trie les sizes par fréquence
        const sortedSizes = Object.entries(sizes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([size]) => size);

        return {
          fonts:   [...fonts].slice(0, 6),
          sizes:   sortedSizes,
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
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'analyse : ' + err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Analyzer] Server running on port ${PORT}`);
});
