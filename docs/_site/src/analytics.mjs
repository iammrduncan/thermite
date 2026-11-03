// Fathom Analytics counts page views without cookies, only on the site's own domain (not on
// pages.dev or a local preview). Both the docs (astro.config.mjs) and the site's own pages
// (src/layouts/Site.astro) load it with these attributes.
export const fathom = {
  src: "https://cdn.usefathom.com/script.js",
  "data-site": "RNENIVAD",
  "data-included-domains": "usethermite.com",
  defer: true,
};
