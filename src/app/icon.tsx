import { ImageResponse } from "next/og";

// Browser-tab favicon — the real BSign mark (public/images/logo.png in
// pagina-estudio, recolored white) on the brand navy, replacing the old
// Hostinger-violet placeholder. Next.js renders this at build time and
// auto-injects <link rel="icon"> into <head>.
//
// Embedded as a data URI rather than composed from primitives: the
// mark's curve is a specific bezier shape, not something worth
// hand-tracing in JSX just to redraw what a raster export already
// gets pixel-exact. The same navy + mark combination is what
// public/icon-192.png / icon-512.png use for the install-prompt and
// home-screen icons (see manifest.ts) — this is just the small
// browser-tab-sized version of the same asset.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const MARK_DATA_URI =
  "data:image/png;base64,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";

export default function Icon() {
  return new ImageResponse(
    (
      // next/image can't run inside ImageResponse's satori renderer — this
      // <img> never touches the real DOM, so the no-img-element lint rule
      // doesn't apply even though it still fires here.
      <img
        src={MARK_DATA_URI}
        width={size.width}
        height={size.height}
        alt=""
      />
    ),
    { ...size },
  );
}
