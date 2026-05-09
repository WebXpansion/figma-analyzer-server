# Figma Site Analyzer — Headless Server

Serveur Node.js + Playwright qui analyse un site web et extrait
les styles computés réels (couleurs, boutons, cards, typographie).

## Déploiement sur Render.com

1. Push ce dossier sur GitHub
2. Sur Render → New Web Service → connecte ton repo
3. Build command : `npm install && npx playwright install chromium --with-deps`
4. Start command : `node server.js`
5. Copie l'URL du service (ex: https://figma-analyzer.onrender.com)

## Usage

POST /analyze
Content-Type: application/json
{ "url": "https://stripe.com" }
