---
id: ref-brand
title: runkle brand
status: current
updated: 2026-11-19
covers:
  - public/index.html
  - public/style.css
  - public/manifest.webmanifest
  - public/apple-touch-icon.png
  - public/fonts/**
---

# runkle brand

The mark is **Fold**: a lowercase r folded from one strip, the arm turned over
at the stem like paper. "Runkle" is an old word for a crease. Keep it clear of
circles and red, which read as a well-known retail bullseye.

## Mark

The master, on a 64 unit grid. The glyph stays inside the centre 80% so the
same art works as a maskable app icon.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1f2a4d"/>
  <polygon points="19,17 30,17 30,48 19,48" fill="#f2b632"/>
  <polygon points="30,17 45,21 45,31 30,27" fill="#f9d681"/>
  <polygon points="30,27 36,28.6 30,33" fill="#b9810f"/>
</svg>
```

| Where | Form |
|---|---|
| Browser tab icon | The SVG above as a data URI in `public/index.html` (`img-src` allows only `data:`). |
| Header wordmark | The SVG inline in `public/index.html`, then "runkle" in Bricolage Grotesque. |
| `public/apple-touch-icon.png` | 180 px, square with no `rx`; iOS rounds it. |
| Manifest icons | 192 and 512 px, square with no `rx`, as data URIs, `any maskable`. |

To redraw the PNGs, render the master without `rx` at each size (for example with
`cairosvg`) and strip metadata.

## Colour

| Token | Light | Dark |
|---|---|---|
| Tile and browser theme | `#1f2a4d` ink | same |
| Stem | `#f2b632` saffron | same |
| Folded arm | `#f9d681` | same |
| Fold shadow | `#b9810f` | same |
| `--accent` (primary buttons, focus) | `#22305a` | `#f2b632` |
| `--on-accent` | `#ffffff` | `#161b2e` |
| `--bg` | `#f4f5f8` | `#11131b` |
| `--surface` | `#ffffff` | `#1a1d28` |
| `--text` | `#161b2e` | `#eef0f6` |
| `--muted` | `#5d6377` | `#9aa0b4` |
| `--line` | `#dfe2ea` | `#2c3142` |

## Type

Bricolage Grotesque 700 for the wordmark and headings, IBM Plex Sans for text,
the system monospace for code. Both fonts are self-hosted in `public/fonts`
under the SIL Open Font License (licence texts beside them), so the CSP needs
only `font-src 'self'`.
