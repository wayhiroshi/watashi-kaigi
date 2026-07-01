# AGENTS.md

## Project Overview

This repository is a Japanese landing page for "AIで考える、これからの私会議".
It is built with plain HTML, CSS, JavaScript, image assets, and a small Cloudflare
Worker API for Stripe Checkout.

## Main Files

- `index.html`: page structure, Japanese copy, SEO/OG metadata, and the application form.
- `style.css`: primary layout and visual design for desktop/tablet/mobile.
- `mobile-hero.css`: mobile-only hero image and copy positioning adjustments.
- `script.js`: client-side form validation and Stripe Checkout redirect flow.
- `src/worker.js`: Cloudflare Worker API that creates Stripe Checkout Sessions.
- `assets/`: production image assets used by the page.
- `wrangler.jsonc`: Cloudflare configuration for static asset deployment.
- `.dev.vars.example`: local environment variable template for Stripe.
- `package.json`: npm scripts for Wrangler, verification, deployment, and git publish.
- `scripts/git-publish.sh`: runs verification, commits, and pushes with a provided message.

## Local Preview

- For a simple local preview, serve the project root with a static server.
- Example: `python3 -m http.server 4173`
- Then open `http://127.0.0.1:4173/`.
- For Stripe/API behavior, use Wrangler from the project root so `/api/*` routes run.
- Use `npm run dev` for local Wrangler preview and `npm run verify` before deploy/push.

## Editing Guidelines

- Keep edits small and focused. This is a polished single-page site, so avoid broad
  rewrites unless the user explicitly asks for a redesign.
- Preserve the warm, approachable Japanese tone for women in their 40s and older.
- Treat the hero section as visually sensitive. After changing hero copy, images, or
  responsive CSS, verify both desktop and smartphone layouts.
- Keep desktop hero behavior in `style.css`. Keep smartphone-only hero overrides in
  `mobile-hero.css` unless a broader refactor is requested.
- Meaningful images should have useful Japanese `alt` text. Decorative images should
  remain `alt=""` with `aria-hidden="true"` where appropriate.
- The form validates required fields, calls `/api/create-checkout-session`, and redirects
  to Stripe Checkout. Keep Stripe secret keys in Cloudflare secrets or `.dev.vars`;
  never commit real secrets.

## Verification Checklist

- Check `git status` before editing and do not overwrite unrelated user changes.
- For visual changes, verify at least one desktop viewport and one mobile viewport.
- For form changes, test empty submit, invalid email, missing consent, and valid submit.
- Before deployment-oriented changes, confirm `wrangler.jsonc` still points assets to
  the project root.
- For Stripe changes, test with Stripe test keys before deploying live keys.
- Use `npm run git:publish -- "message"` only when the user wants to commit and push.
