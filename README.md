# Ultimate Prompt Architect

Ultimate Prompt Architect is a static browser app for building production grade system prompts for Claude Opus 4.6, Gemini 3 Pro, and other modern reasoning models.

## What it does

- Builds complete markdown prompt files with title, filename, description, key features, parameters, and final prompt.
- Supports new prompt creation, prompt modification, prompt audits, and agentic workflow prompts.
- Includes a surgical modification protocol for preserving formatting when editing existing prompts.
- Adds context first structure and prompt injection defenses for pasted user material.
- Recommends model specific parameters for Claude Opus 4.6 and Gemini 3 Pro.
- Runs entirely in the browser with no backend, no database, and no paid services required.
- Supports copy, markdown download, demo loading, local snapshot saving, and offline caching.

## Files

- `index.html` - Main app shell.
- `styles.css` - Responsive launch ready styling.
- `app.js` - Prompt generation, validation, copy, download, save, and demo logic.
- `manifest.webmanifest` - PWA metadata.
- `sw.js` - Offline cache service worker.
- `privacy.html` - Simple public privacy page.
- `terms.html` - Simple public terms page.
- `robots.txt` - Search engine crawl rules.
- `.nojekyll` - GitHub Pages compatibility.

## Launch options

This app is static. Deploy it with any basic static host.

### GitHub Pages

1. Open the repository settings.
2. Go to Pages.
3. Set Source to Deploy from a branch.
4. Choose `main` and `/root`.
5. Save.

### Netlify or Vercel

Import the repository and deploy the root directory. No build command is required.

## Local use

Open `index.html` in a browser. For service worker testing, serve the folder with any local static server.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Public launch checklist

- Review the generated prompt defaults in `app.js`.
- Confirm the privacy and terms pages match your business requirements.
- Enable GitHub Pages or connect the repository to your static host.
- Test copy and download on mobile and desktop.
- Generate one demo prompt and verify the validation checks pass.
