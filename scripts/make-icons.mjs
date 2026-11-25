// Draws the source images that `npm run icons` hands to @capacitor/assets,
// which then produces every iOS, Android and PWA icon and splash size.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("assets", { recursive: true });
const BLUE = "#2046c7";

// A speech bubble with "Aa": reading aloud + vocabulary.
const mark = (scale = 1) => `
  <g transform="translate(512 512) scale(${scale}) translate(-512 -512)">
    <path d="M232 262 h560 a72 72 0 0 1 72 72 v300 a72 72 0 0 1 -72 72 h-300 l-150 118 v-118 h-110 a72 72 0 0 1 -72 -72 v-300 a72 72 0 0 1 72 -72 z" fill="#ffffff"/>
    <text x="512" y="610" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="300" fill="${BLUE}">Aa</text>
  </g>`;

const svg = (body, bg, size = 1024) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${bg ? `<rect width="1024" height="1024" fill="${bg}"/>` : ""}${body}</svg>`);

await sharp(svg(mark(1), BLUE)).png().toFile("assets/icon-only.png");
await sharp(svg(mark(0.72), null)).png().toFile("assets/icon-foreground.png"); // Android adaptive: keep inside safe zone
await sharp(svg("", BLUE)).png().toFile("assets/icon-background.png");

const splash = (bg) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732"><rect width="2732" height="2732" fill="${bg}"/>
   <g transform="translate(1110 1110) scale(0.5)"><rect width="1024" height="1024" rx="220" fill="${BLUE}"/>${mark(1)}</g></svg>`);
await sharp(splash("#eef1f4")).png().toFile("assets/splash.png");
await sharp(splash("#10161d")).png().toFile("assets/splash-dark.png");
console.log("Source images written to assets/");

// Web/PWA icons (PNG: iOS Safari needs PNG for the home-screen icon).
mkdirSync("public/icons", { recursive: true });
for (const size of [192, 512]) await sharp("assets/icon-only.png").resize(size).png().toFile(`public/icons/icon-${size}.png`);
await sharp("assets/icon-only.png").resize(180).png().toFile("public/icons/apple-touch-icon.png");
await sharp("assets/icon-only.png").resize(32).png().toFile("public/icons/favicon-32.png");
console.log("Web icons written to public/icons/");
