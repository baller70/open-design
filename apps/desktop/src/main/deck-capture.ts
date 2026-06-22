import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, nativeImage } from "electron";
import type { DesktopRenderSlidesInput, DesktopRenderSlidesResult } from "@open-design/sidecar-proto";

import { waitForPrintableContent } from "./pdf-export.js";

// Returns the rendered images either as on-disk files (when the daemon provided
// an `outputDir`) or as base64 data URLs (legacy/fallback). Writing files keeps
// tens of MB of image bytes off the JSON IPC channel — the daemon, which owns
// and created the directory, reads the files back and deletes them. desktop only
// ever writes to the absolute path the daemon handed it.
async function emitImages(
  images: Array<{ buffer: Buffer; jpeg: boolean }>,
  outputDir: string | undefined,
): Promise<Pick<DesktopRenderSlidesResult, "slideFiles" | "slides">> {
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const slideFiles: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i]!;
      const file = path.join(outputDir, `slide-${i}.${img.jpeg ? "jpeg" : "png"}`);
      await writeFile(file, img.buffer);
      slideFiles.push(file);
    }
    return { slideFiles };
  }
  return {
    slides: images.map(
      (img) => `data:image/${img.jpeg ? "jpeg" : "png"};base64,${img.buffer.toString("base64")}`,
    ),
  };
}

// Default deck slide stage when the authored size can't be measured: 1920x1080
// (16:9). We render at the logical size and let Electron's capturePage emit the
// display's native pixel scale (2x on retina => 3840x2160), so the PNGs are at
// least FHD and pixel-perfect to the browser. This reuses the bundled Electron
// Chromium — no second headless engine, so the packaged app does not grow.
const SLIDE_W = 1920;
const SLIDE_H = 1080;
// Bounds for a measured slide size; outside this we fall back to the default to
// avoid a pathological capture (a deck with a broken/zero/huge slide box).
const SLIDE_MIN_PX = 320;
const SLIDE_MAX_PX = 8192;

// Chrome the live deck adds (presenter overlays, the auto-managed progress bar,
// nav hints) must not bleed into a captured slide. Mirrors the print-hide list
// in design-templates/html-ppt/assets/runtime.js.
const HIDE_CHROME_SELECTOR =
  ".progress-bar, .notes-overlay, .overview, .notes, aside.notes, .speaker-notes, .deck-nav, .deck-hint, .deck-counter";

// All `.slide` elements anywhere in the document — decks nest them differently
// (`.deck > .slide`, `.deck-viewport > .deck-stage > .slide`, etc.). Presenter-
// mode clones (`.mini-slide .slide`, `.overview .slide`) are filtered out in the
// page (see realSlidesExpr) rather than via a rigid direct-child selector, which
// missed nested decks.
const SLIDE_SELECTOR = ".slide";
// JS expression (used inside executeJavaScript) returning the real slides.
const REAL_SLIDES_JS =
  "Array.prototype.slice.call(document.querySelectorAll('.slide')).filter(function(el){return !el.closest('.mini-slide, .overview, .notes-overlay, .thumb')})";

/**
 * Renders an HTML deck to one PNG per slide using a hidden Electron window.
 * The window is shown fully transparent and inactive so the GPU compositor
 * paints it (capturePage needs a live frame) without any visible flash or
 * focus theft, then destroyed.
 */
export async function renderDeckSlides(
  input: DesktopRenderSlidesInput,
): Promise<DesktopRenderSlidesResult> {
  const window = new BrowserWindow({
    width: SLIDE_W,
    height: SLIDE_H,
    useContentSize: true,
    show: false,
    // The deck is 1920x1080. Without this, macOS clamps a window taller than
    // the work area (laptop displays), so the content viewport comes back
    // shorter than 1080 and slides capture at the wrong aspect ratio.
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  // Coarse per-phase timing so a slow export can be diagnosed from the desktop
  // log (load/fonts vs. render/encode) instead of guesswork. One line per export.
  const t0 = Date.now();
  let tLoad = t0;
  let tAssets = t0;
  let tPrepare = t0;
  const finish = (result: DesktopRenderSlidesResult): DesktopRenderSlidesResult => {
    const end = Date.now();
    // eslint-disable-next-line no-console
    console.info("[od-export] render", {
      mode: result.mode,
      slides: (result.slideFiles ?? result.slides ?? []).length,
      out: result.slideFiles ? "file" : "dataurl",
      loadMs: tLoad - t0,
      assetsMs: tAssets - tLoad,
      prepareMs: tPrepare - tAssets,
      renderMs: end - tPrepare,
      totalMs: end - t0,
    });
    return result;
  };

  try {
    const doc = injectBaseHref(input.html, input.baseHref);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
    tLoad = Date.now();
    await waitForPrintableContent(window);
    tAssets = Date.now();

    // Lay out at the default stage first so the slide box can be measured
    // against a stable viewport.
    window.setContentSize(SLIDE_W, SLIDE_H);

    // Paint invisibly: opacity 0 before showInactive => compositor renders the
    // page (so capturePage returns real pixels) with zero on-screen flash.
    window.setOpacity(0);
    window.showInactive();

    const count = (await window.webContents.executeJavaScript(
      `(${prepareDeck.toString()})(${JSON.stringify(SLIDE_SELECTOR)}, ${JSON.stringify(HIDE_CHROME_SELECTOR)})`,
      true,
    )) as number;
    tPrepare = Date.now();

    // No `.slide` sections — this is an ordinary page (e.g. a website), not a
    // deck. Capture the whole document at its natural size instead of forcing a
    // 1920x1080 slide. This is what image export of a non-deck artifact wants.
    if (!Number.isInteger(count) || count < 1) {
      return finish(await capturePage(window, input.pageImageFormat === "jpeg", input.outputDir));
    }

    // Measure the deck's authored slide size instead of assuming 16:9 — decks
    // can be 4:3, square, portrait, or any custom canvas. The capture rect, the
    // pinned stage, and (downstream) the PPTX layout all follow this so a non-16:9
    // deck is not clipped or distorted. Falls back to 1920x1080 if unmeasurable.
    const stage = await measureSlideStage(window);
    window.setContentSize(stage.w, stage.h);
    await nextFrames(window);

    // Pin the stage to the measured slide size.
    await window.webContents.executeJavaScript(`(${pinDeckStage.toString()})(${stage.w}, ${stage.h})`, true);

    // Image export of a deck wants every slide stitched top-to-bottom into one
    // tall image (the "whole deck as one picture").
    if (input.stitch) {
      return finish(
        await stitchDeckSlides(window, count, stage, input.pageImageFormat === "jpeg", input.outputDir),
      );
    }

    // Otherwise render every slide (or just the one requested by image export).
    const indices =
      input.index != null && input.index >= 0 && input.index < count ? [input.index] : range(count);
    const jpeg = input.pageImageFormat === "jpeg";
    const images: Array<{ buffer: Buffer; jpeg: boolean }> = [];
    let width = stage.w;
    let height = stage.h;
    for (const i of indices) {
      await showDeckSlide(window, i, stage);
      // Clip to the exact measured slide rect (DIP) so the PNG aspect always
      // matches the authored deck, even if the window content rounds differently.
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: stage.w, height: stage.h });
      const size = image.getSize();
      width = size.width;
      height = size.height;
      images.push({ buffer: jpeg ? image.toJPEG(82) : image.toPNG(), jpeg });
    }
    return finish({ ok: true, ...(await emitImages(images, input.outputDir)), width, height, mode: "deck" });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

// The measured (or fallback) logical slide stage in DIP.
interface Stage {
  w: number;
  h: number;
}

// Measures the deck's authored slide box so the capture/PPTX follow the real
// aspect ratio instead of assuming 16:9. Reads the rendered (post-transform)
// rect of the first slide that has layout, so a fit-to-viewport deck reports the
// stage it actually paints. Clamps to a sane range and falls back to 1920x1080.
async function measureSlideStage(window: BrowserWindow): Promise<Stage> {
  try {
    const measured = (await window.webContents.executeJavaScript(
      `(${measureSlide.toString()})(${JSON.stringify(SLIDE_SELECTOR)})`,
      true,
    )) as { w: number; h: number } | null;
    if (
      measured &&
      Number.isFinite(measured.w) &&
      Number.isFinite(measured.h) &&
      measured.w >= SLIDE_MIN_PX &&
      measured.w <= SLIDE_MAX_PX &&
      measured.h >= SLIDE_MIN_PX &&
      measured.h <= SLIDE_MAX_PX
    ) {
      return { w: Math.round(measured.w), h: Math.round(measured.h) };
    }
  } catch {
    // fall through to the default stage
  }
  return { w: SLIDE_W, h: SLIDE_H };
}

// Shows exactly slide `i` and lets the style change settle for two frames. The
// style toggle AND the two-frame settle happen in ONE executeJavaScript round
// trip (showSlide returns the settle Promise, which executeJavaScript awaits) —
// halving the main<->renderer hops per slide vs. a separate settle call, which
// matters for long decks where the loop dominates.
async function showDeckSlide(window: BrowserWindow, i: number, stage: Stage): Promise<void> {
  const rect = (await window.webContents.executeJavaScript(
    `(${showSlide.toString()})(${JSON.stringify(SLIDE_SELECTOR)}, ${i})`,
    true,
  )) as { x: number; y: number; w: number; h: number } | null;
  // If the active slide did not land in the top-left capture viewport (a
  // translated carousel strip leaves it off-screen), restack it into place and
  // settle again before the caller captures.
  const onStage =
    rect != null &&
    Math.abs(rect.x) <= 2 &&
    Math.abs(rect.y) <= 2 &&
    rect.w >= stage.w * 0.5 &&
    rect.h >= stage.h * 0.5;
  if (!onStage) {
    await window.webContents.executeJavaScript(
      `(${restackActiveSlide.toString()})(${JSON.stringify(SLIDE_SELECTOR)}, ${i}, ${stage.w}, ${stage.h})`,
      true,
    );
    await nextFrames(window);
  }
}

// Captures every deck slide and stacks them top-to-bottom into one tall image
// (deck image export). Stitches BGRA with a native memcpy per slide and encodes
// once natively, like the scroll-segment path. Caps total height so a very long
// deck can't exceed the bitmap limit / RAM.
const DECK_STITCH_MAX_H = 30000;
async function stitchDeckSlides(
  window: BrowserWindow,
  count: number,
  stage: Stage,
  jpeg: boolean,
  outputDir: string | undefined,
): Promise<DesktopRenderSlidesResult> {
  let W = 0;
  let slideHpx = 0;
  let bgra: Buffer | null = null;
  let maxSlides = count;
  let placed = 0;
  for (let i = 0; i < count; i++) {
    await showDeckSlide(window, i, stage);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: stage.w, height: stage.h });
    const bmp = image.toBitmap(); // BGRA, full-width rows
    const size = image.getSize();
    if (!bgra) {
      W = size.width;
      slideHpx = size.height;
      maxSlides = Math.max(1, Math.min(count, Math.floor(DECK_STITCH_MAX_H / slideHpx)));
      bgra = Buffer.alloc(W * slideHpx * maxSlides * 4);
    }
    if (placed >= maxSlides) break;
    bmp.copy(bgra, placed * slideHpx * W * 4, 0, Math.min(bmp.length, slideHpx * W * 4));
    placed++;
  }
  const H = slideHpx * placed;
  const img = nativeImage.createFromBitmap(bgra ?? Buffer.alloc(4), { width: W || 1, height: H || 1 });
  const bytes = jpeg ? img.toJPEG(82) : img.toPNG();
  return {
    ok: true,
    ...(await emitImages([{ buffer: bytes, jpeg }], outputDir)),
    width: W,
    height: H,
    mode: "deck",
  };
}

// Ordinary (non-deck) page: capture the WHOLE document as one long image at a
// fixed desktop width, viewport-independent.
const PAGE_W = 1440;
// Logical viewport height used for the scroll-segment fallback.
const PAGE_VIEW_H = 1000;
// RAM budget for the stitched output buffer (~RGBA). Bounds the worst-case
// output height regardless of how tall the page is.
const PAGE_RAM_BUDGET_BYTES = 320 * 1024 * 1024;
// Conservative floor for the per-machine GPU texture limit if we cannot query
// it (older/integrated GPUs can be as low as this).
const FALLBACK_MAX_TEXTURE = 8192;

/**
 * Captures an ordinary page as one long, viewport-independent image. Picks the
 * technique automatically (the caller and the user only ever see "full page"):
 *  1) Chromium's `captureBeyondViewport` — one clean off-screen pass; fixed
 *     elements are NOT duplicated. Used when the output fits the machine's real
 *     GPU texture limit AND below-the-fold content actually rendered.
 *  2) scroll-segment stitch — when (1) would exceed the texture limit, errors,
 *     or comes back blank below the fold (scroll-driven pages). RAM-bound, so it
 *     handles arbitrarily long pages; capped by a memory budget.
 */
async function capturePage(
  window: BrowserWindow,
  jpeg: boolean,
  outputDir: string | undefined,
): Promise<DesktopRenderSlidesResult> {
  // Lay the document out at a desktop width first so width-dependent content
  // (responsive layouts) renders the way a desktop visitor sees it.
  window.setContentSize(PAGE_W, PAGE_VIEW_H);
  await nextFrames(window);

  // Pre-pass: freeze animations and scroll the whole page once so reveal-on-
  // scroll content (IntersectionObserver / AOS / lazy images) is triggered and
  // settles. This lets the clean one-shot captureBeyondViewport succeed for most
  // animated pages instead of coming back blank and falling to scroll-segment.
  await preparePageForCapture(window);

  const maxTexture = await queryMaxTextureSize(window);
  // The window's device-pixel-ratio already scales the capture (2 on retina),
  // exactly like the deck path's capturePage. Report real px via it.
  const dpr = await queryDevicePixelRatio(window);
  const outW = PAGE_W * dpr;
  const ramMaxOutH = Math.floor(PAGE_RAM_BUDGET_BYTES / (outW * 4));

  const dbg = window.webContents.debugger;
  let attached = false;
  try {
    dbg.attach("1.3");
    attached = true;
  } catch {
    // already attached or unavailable — scroll-segment fallback below
  }

  try {
    if (attached) {
      await dbg.sendCommand("Page.enable");
      // Measure the document height in CSS px directly (CDP contentSize is in
      // device px in this Electron, which would double-scale). Clip width to the
      // desktop viewport we laid out at — horizontal overflow is rare and a
      // desktop-width capture is what we want.
      const measuredH = (await window.webContents.executeJavaScript(
        "Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))",
        true,
      )) as number;
      const docW = PAGE_W;
      const docH = Math.max(1, Number.isFinite(measuredH) ? measuredH : PAGE_VIEW_H);
      const outWpx = docW * dpr;
      const outHpx = docH * dpr;

      // captureBeyondViewport is viable only when the single output texture fits
      // the machine's real limit on BOTH axes and within the RAM budget.
      const fitsSinglePass =
        outWpx <= maxTexture && outHpx <= maxTexture && outHpx <= ramMaxOutH;
      if (fitsSinglePass && !(await isScrollBound(window, dbg, docW, docH))) {
        // scale:1 — the window DPR already provides the pixel scale, so this
        // avoids double-scaling (DPR x clip.scale).
        const shot = (await dbg.sendCommand("Page.captureScreenshot", {
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: docW, height: docH, scale: 1 },
          ...(jpeg ? { format: "jpeg", quality: 82 } : { format: "png" }),
        })) as { data: string };
        return {
          ok: true,
          ...(await emitImages([{ buffer: Buffer.from(shot.data, "base64"), jpeg }], outputDir)),
          width: outWpx,
          height: outHpx,
          mode: "page",
        };
      }
      // Otherwise fall through to scroll-segment (too tall, or blank below fold).
      const cappedLogicalH = Math.min(docH, Math.floor(ramMaxOutH / dpr));
      return await scrollSegmentStitch(window, cappedLogicalH, jpeg, outputDir);
    }
  } catch {
    // CDP path failed — fall through to scroll-segment.
  } finally {
    if (attached) {
      try {
        dbg.detach();
      } catch {
        // ignore
      }
    }
  }

  // No debugger available: measure + scroll-segment.
  const measured = (await window.webContents.executeJavaScript(
    "Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))",
    true,
  )) as number;
  const totalLogical = Math.max(
    PAGE_VIEW_H,
    Math.min(Number.isFinite(measured) ? measured : PAGE_VIEW_H, Math.floor(ramMaxOutH / dpr)),
  );
  return await scrollSegmentStitch(window, totalLogical, jpeg, outputDir);
}

// Freezes animations/transitions and scroll-prewarms the page so reveal-on-
// scroll content (IntersectionObserver, AOS, `loading=lazy`) is triggered and
// holds before capture — the standard technique full-page screenshot services
// use. Does NOT fix JS that recomputes transforms from scrollY every frame
// (continuous parallax): those have no single correct frame and still fall to
// scroll-segment via the blank-below-fold check.
async function preparePageForCapture(window: BrowserWindow): Promise<void> {
  try {
    await window.webContents.executeJavaScript(
      `(function(){try{var s=document.createElement('style');s.setAttribute('data-od-capture','1');s.textContent='*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';(document.head||document.documentElement).appendChild(s);}catch(e){}})()`,
      true,
    );
    await window.webContents.executeJavaScript(
      `(async function(){var vh=window.innerHeight||1000;var H=function(){return Math.max(document.documentElement.scrollHeight, document.body?document.body.scrollHeight:0)};for(var y=0;y<H();y+=vh){window.scrollTo(0,y);await new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r)})});await new Promise(function(r){setTimeout(r,120)});}window.scrollTo(0,0);await new Promise(function(r){setTimeout(r,200)});return true;})()`,
      true,
    );
    // Wait for any fonts / images / CSS bg images that loaded during the prewarm.
    await waitForPrintableContent(window);
  } catch {
    // Best-effort — capture proceeds even if the pre-pass fails.
  }
}

// Window device-pixel-ratio (2 on retina). capturePage / captureScreenshot both
// scale the output by it, so we use it to compute real output pixel sizes.
async function queryDevicePixelRatio(window: BrowserWindow): Promise<number> {
  try {
    const v = (await window.webContents.executeJavaScript("window.devicePixelRatio || 1", true)) as number;
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

// Reads the GPU's real max texture size so the single-pass/stitch threshold
// adapts to the user's hardware instead of a hard-coded guess.
async function queryMaxTextureSize(window: BrowserWindow): Promise<number> {
  try {
    const v = (await window.webContents.executeJavaScript(
      `(function(){try{var c=document.createElement('canvas');var gl=c.getContext('webgl2')||c.getContext('webgl');return gl?gl.getParameter(gl.MAX_TEXTURE_SIZE):0}catch(e){return 0}})()`,
      true,
    )) as number;
    return Number.isFinite(v) && v > 0 ? v : FALLBACK_MAX_TEXTURE;
  } catch {
    return FALLBACK_MAX_TEXTURE;
  }
}

// Detects whether the page is scroll-driven (content only paints when scrolled
// into view) — the case where captureBeyondViewport comes back blank in the
// middle. Compares the document's MIDDLE band rendered two ways:
//   A = scrolled into view (live viewport) — the real content
//   B = captureBeyondViewport at scroll 0 — what the one-shot would produce
// If they differ a lot, the one-shot would be wrong for this page -> stitch.
// This does NOT rely on color, so a legitimately dark design (where A == B,
// both dark) is correctly NOT flagged, unlike a flat-color heuristic.
async function isScrollBound(
  window: BrowserWindow,
  dbg: Electron.Debugger,
  docW: number,
  docH: number,
): Promise<boolean> {
  const vh = PAGE_VIEW_H;
  if (docH <= vh * 2) return false; // too short to have a hidden middle
  const mid = Math.max(0, Math.floor(docH / 2 - vh / 2));
  try {
    // A: scroll the middle into view and capture the live viewport.
    await window.webContents.executeJavaScript(
      `(function(){window.scrollTo(0, ${mid});return new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(function(){r(true)},150)})})})})()`,
      true,
    );
    const a = (await window.webContents.capturePage({ x: 0, y: 0, width: PAGE_W, height: vh })).toBitmap();
    // B: the same document band as the one-shot renders it (scroll-independent).
    await window.webContents.executeJavaScript("window.scrollTo(0,0); true", true);
    const shot = (await dbg.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: mid, width: docW, height: vh, scale: 1 },
    })) as { data: string };
    const b = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64")).toBitmap();
    const n = Math.min(a.length, b.length);
    if (n < 16) return false;
    let diff = 0;
    let cnt = 0;
    for (let i = 0; i + 2 < n; i += 4 * 97) {
      diff += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
      cnt++;
    }
    const meanDiff = cnt ? diff / (cnt * 3) : 0;
    // ~9% mean per-channel difference => the middle renders differently when
    // scrolled vs one-shot => scroll-driven => use stitch.
    return meanDiff > 24;
  } catch {
    return false;
  }
}

// Scrolls the page one viewport at a time, captures each frame, and stitches
// them by real scroll offset into one tall BGRA buffer, then encodes once with
// Electron's native PNG encoder. Stitching is a single Buffer.copy per chunk
// (no per-pixel JS, no channel swap — capturePage already gives BGRA, which is
// what createFromBitmap wants) and the encode is native C++, so this is fast
// even for long pages. createFromBitmap is a CPU bitmap, so it is NOT bound by
// the GPU texture limit; height is bounded only by the caller's RAM cap.
async function scrollSegmentStitch(
  window: BrowserWindow,
  totalLogical: number,
  jpeg: boolean,
  outputDir: string | undefined,
): Promise<DesktopRenderSlidesResult> {
  window.setContentSize(PAGE_W, PAGE_VIEW_H);
  await nextFrames(window);
  const maxScroll = Math.max(0, totalLogical - PAGE_VIEW_H);

  // Scale (DPR) is derived from the first captured chunk so placement is correct
  // regardless of the display's pixel ratio.
  let scale = 0;
  let W = 0;
  let H = 0;
  let bgra: Buffer | null = null;

  for (let y = 0; ; y += PAGE_VIEW_H) {
    const target = Math.min(y, maxScroll);
    const actualY = (await window.webContents.executeJavaScript(
      `(function(){window.scrollTo(0, ${target});return new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(function(){r(Math.round(window.scrollY||window.pageYOffset||0))},180)})})})})()`,
      true,
    )) as number;
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: PAGE_W, height: PAGE_VIEW_H });
    const bmp = image.toBitmap(); // BGRA
    const size = image.getSize();
    if (!bgra) {
      scale = Math.max(1, Math.round(size.width / PAGE_W));
      W = PAGE_W * scale;
      H = totalLogical * scale;
      bgra = Buffer.alloc(W * H * 4);
    }
    // Chunk width matches W (captured at PAGE_W), so each chunk's rows are
    // contiguous and full-width — copy the whole block in one native memcpy.
    if (size.width === W) {
      const destStart = actualY * scale * W * 4;
      const rows = Math.min(size.height, H - actualY * scale);
      bmp.copy(bgra, destStart, 0, rows * W * 4);
    } else {
      // Defensive: width mismatch — copy row by row (still native per-row copy).
      const rows = Math.min(size.height, H - actualY * scale);
      for (let r = 0; r < rows; r++) {
        bmp.copy(bgra, (actualY * scale + r) * W * 4, r * size.width * 4, r * size.width * 4 + Math.min(size.width, W) * 4);
      }
    }
    if (target >= maxScroll) break;
  }

  const img = nativeImage.createFromBitmap(bgra ?? Buffer.alloc(4), { width: W || 1, height: H || 1 });
  const bytes = jpeg ? img.toJPEG(82) : img.toPNG();
  return {
    ok: true,
    ...(await emitImages([{ buffer: bytes, jpeg }], outputDir)),
    width: W,
    height: H,
    mode: "page",
  };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

async function nextFrames(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true)})})})",
    true,
  );
}

function injectBaseHref(doc: string, baseHref: string | undefined): string {
  if (!baseHref) return doc;
  const tag = `<base href="${escapeHtmlAttribute(baseHref)}">`;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (match) => `${match}${tag}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (match) => `${match}<head>${tag}</head>`);
  return `<!doctype html><html><head>${tag}</head><body>${doc}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Functions serialized into the page (kept dependency-free) ---

function prepareDeck(slideSelector: string, hideSelector: string): number {
  document.querySelectorAll(hideSelector).forEach((el) => {
    (el as HTMLElement).style.setProperty("display", "none", "important");
  });
  // Freeze animations/transitions so each slide (and its reveal-on-show inner
  // elements, e.g. `.slide.visible .reveal`) reaches its final state instantly.
  const s = document.createElement("style");
  s.textContent =
    "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}";
  (document.head || document.documentElement).appendChild(s);
  return Array.prototype.slice
    .call(document.querySelectorAll(slideSelector))
    .filter((el) => !(el as HTMLElement).closest(".mini-slide, .overview, .notes-overlay, .thumb")).length;
}

// Deck-only: pin to the measured WxH stage so each slide captures
// deterministically. NOT applied in page mode — an ordinary page must keep its
// natural width/height.
function pinDeckStage(w: number, h: number): void {
  const style = document.createElement("style");
  style.textContent =
    `html,body{margin:0!important;padding:0!important;width:${w}px!important;height:${h}px!important;overflow:hidden!important}` +
    `.deck{width:${w}px!important;height:${h}px!important}`;
  document.head.appendChild(style);
}

// Serialized into the page: measures the authored slide box. Prefers a slide
// that already has a non-zero layout rect (covers decks that hide inactive
// slides via opacity/visibility); if every slide is display:none, force-measures
// the first one off-screen. Returns the rendered DIP size or null.
function measureSlide(slideSelector: string): { w: number; h: number } | null {
  const slides = Array.prototype.slice
    .call(document.querySelectorAll(slideSelector))
    .filter((el) => !(el as HTMLElement).closest(".mini-slide, .overview, .notes-overlay, .thumb"));
  if (slides.length === 0) return null;
  for (const node of slides) {
    const r = (node as HTMLElement).getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return { w: r.width, h: r.height };
  }
  const el = slides[0] as HTMLElement;
  const prev = el.style.cssText;
  el.style.setProperty("display", "block", "important");
  el.style.setProperty("visibility", "hidden", "important");
  const rect = el.getBoundingClientRect();
  el.style.cssText = prev;
  return rect.width > 1 && rect.height > 1 ? { w: rect.width, h: rect.height } : null;
}

// Returns a Promise that resolves after the style change has settled for two
// animation frames, so the caller can show + wait in a single round trip.
function showSlide(slideSelector: string, index: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const slides = Array.prototype.slice
    .call(document.querySelectorAll(slideSelector))
    .filter((el) => !(el as HTMLElement).closest(".mini-slide, .overview, .notes-overlay, .thumb"));
  // Cover the common deck "active slide" conventions so the deck's own CSS shows
  // the slide (incl. visibility:hidden->visible and reveal animations), plus
  // inline overrides as a backstop for decks that hide via opacity/visibility.
  const activeClasses = ["active", "visible", "is-active", "current"];
  slides.forEach((node, k) => {
    const el = node as HTMLElement;
    const on = k === index;
    el.style.transition = "none";
    el.style.animation = "none";
    el.style.opacity = on ? "1" : "0";
    el.style.visibility = on ? "visible" : "hidden";
    el.style.transform = "none";
    el.style.pointerEvents = on ? "auto" : "none";
    el.style.zIndex = on ? "999" : "0";
    activeClasses.forEach((c) => el.classList.toggle(c, on));
  });
  // Report where the active slide actually landed after two frames, so the
  // capturer can detect a slide that the deck keeps off-screen (e.g. a
  // horizontal carousel that paginates by translating a flex strip rather than
  // stacking slides in place) and restack it before capturing.
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = slides[index] as HTMLElement | undefined;
        if (!el) return resolve(null);
        const r = el.getBoundingClientRect();
        resolve({ x: r.x, y: r.y, w: r.width, h: r.height });
      }),
    );
  });
}

// Serialized into the page: forces the active slide into the top-left capture
// viewport for decks that position it elsewhere (translated carousel strip).
// Only used when showSlide reports the slide off-stage, so transform-scaled
// fit-to-viewport decks (whose active slide is already at 0,0) are untouched —
// clearing ancestor transforms here is safe because such off-stage decks do not
// rely on an ancestor scale.
function restackActiveSlide(slideSelector: string, index: number, w: number, h: number): void {
  const slides = Array.prototype.slice
    .call(document.querySelectorAll(slideSelector))
    .filter((el) => !(el as HTMLElement).closest(".mini-slide, .overview, .notes-overlay, .thumb"));
  const el = slides[index] as HTMLElement | undefined;
  if (!el) return;
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.documentElement) {
    node.style.setProperty("transform", "none", "important");
    node.style.setProperty("transition", "none", "important");
    node = node.parentElement;
  }
  el.style.setProperty("position", "fixed", "important");
  el.style.setProperty("left", "0", "important");
  el.style.setProperty("top", "0", "important");
  el.style.setProperty("margin", "0", "important");
  el.style.setProperty("width", `${w}px`, "important");
  el.style.setProperty("height", `${h}px`, "important");
  el.style.setProperty("transform", "none", "important");
  el.style.setProperty("z-index", "2147483647", "important");
}
