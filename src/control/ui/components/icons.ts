/**
 * The dashboard's icons: Thermite's flame character, the same as the docs site's
 * (docs/_site/public/favicon.svg, and the favicon.ico and apple-touch-icon.png made from it;
 * icons.test.ts keeps them the same). Control serves them at the root, with no sign-in, so the
 * sign-in page has them too: browsers ask for /favicon.ico by themselves, and Safari takes no SVG.
 */

export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Thermite">\n  <style>.small{display:none}@media (max-width:24px){.edge{stroke-width:3.6}.full{display:none}.small{display:inline}}</style>\n  <path class="edge" d="M35 3C35 3 37.67 8.17 39 10.5C40.33 12.83 42.25 16.89 43 17C43.75 17.11 49 12 49 12C49 12 51.33 17.42 52.5 20.5C53.67 23.58 55.25 27 56 30.5C56.75 34 57.42 37.83 57 41.5C56.58 45.17 55.5 49.5 53.5 52.5C51.5 55.5 48.58 57.92 45 59.5C41.42 61.08 36.33 62 32 62C27.67 62 22.58 61.08 19 59.5C15.42 57.92 12.5 55.5 10.5 52.5C8.5 49.5 7.33 45.08 7 41.5C6.67 37.92 7.75 34.17 8.5 31C9.25 27.83 10.92 25.25 11.5 22.5C12.08 19.75 12 14.5 12 14.5C12 14.5 15.92 18.08 17.5 19.5C19.08 20.92 21.05 23.34 21.5 23C21.95 22.66 22.33 17.5 23.5 15C24.67 12.5 26.58 10 28.5 8C30.42 6 35 3 35 3Z" fill="#f0712a" stroke="#111315" stroke-width="3" stroke-linejoin="round"/>\n  <path d="M33.5 15C33.5 15 36.25 19.58 38 22C39.75 24.42 42.25 26.67 44 29.5C45.75 32.33 47.83 35.75 48.5 39C49.17 42.25 49 46.17 48 49C47 51.83 45.17 54.42 42.5 56C39.83 57.58 35.5 58.5 32 58.5C28.5 58.5 24.17 57.58 21.5 56C18.83 54.42 17 51.75 16 49C15 46.25 15.08 42.58 15.5 39.5C15.92 36.42 17.42 33.17 18.5 30.5C19.58 27.83 22 23.5 22 23.5C22 23.5 24.92 28.71 25.5 28.5C26.08 28.29 27.67 23.25 29 21C30.33 18.75 33.5 15 33.5 15Z" fill="#ffcf94"/>\n  <path d="M33 26C33 26 35.83 29.08 37.5 31C39.17 32.92 41.75 35.08 43 37.5C44.25 39.92 45.17 42.92 45 45.5C44.83 48.08 44.17 51.25 42 53C39.83 54.75 35.33 56 32 56C28.67 56 24.17 54.75 22 53C19.83 51.25 19.17 48.08 19 45.5C18.83 42.92 19.75 39.83 21 37.5C22.25 35.17 24.5 33.42 26.5 31.5C28.5 29.58 33 26 33 26Z" fill="#fff6da"/>\n  <ellipse cx="20.4" cy="48.2" rx="3.6" ry="2.1" fill="#ffad7c" opacity="0.9"/><ellipse cx="43.6" cy="48.2" rx="3.6" ry="2.1" fill="#ffad7c" opacity="0.9"/>\n  <g class="full"><ellipse cx="25" cy="41.5" rx="3.8" ry="5.1" fill="#111315"/><circle cx="23.63" cy="39.26" r="1.05" fill="#fdfdfd"/><ellipse cx="39" cy="41.5" rx="3.8" ry="5.1" fill="#111315"/><circle cx="37.63" cy="39.26" r="1.05" fill="#fdfdfd"/><path d="M28.2 47.6Q32 48.2 35.8 47.6Q35.65 52.4 32 52.55Q28.35 52.4 28.2 47.6Z" fill="#642d24" stroke="#111315" stroke-width="1.4" stroke-linejoin="round"/><path d="M30.1 51.56Q32 49.82 33.9 51.56Q32 52.48 30.1 51.56Z" fill="#df482e"/></g>\n  <g class="small" fill="#111315"><rect x="20" y="36" width="8" height="12" rx="3"/><rect x="36" y="36" width="8" height="12" rx="3"/><path d="M28 48H36V50.5Q36 52 34.5 52H29.5Q28 52 28 50.5Z"/></g>\n</svg>';

/** 16, 32 and 48 pixels, PNGs in an ICO. */
export const FAVICON_ICO = Buffer.from(
  "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",
  "base64",
);

/** 180 pixels, the flame on a dark square, for a page saved on iOS. */
export const APPLE_TOUCH_ICON = Buffer.from(
  "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" +
    "drZCkonO1gAAAABJRU5ErkJggg==",
  "base64",
);

/** The links every dashboard page's head has. */
export const ICON_LINKS =
  '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
