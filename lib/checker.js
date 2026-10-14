import { chromium } from "playwright";

import * as reveal from "./engines/reveal.js";
import * as remark from "./engines/remark.js";

import {
  DEFAULT_TIMEOUT,
  normalizeInput,
  sleep,
  getBrowserInfo,
  waitForAssets,
  addDisableAnimationsCss,
  combineMeasurements,
  saveScreenshot,
  slideLabel,
} from "./shared.js";

const ENGINES = [reveal, remark];

export async function checkPresentation(options) {
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      viewport: {
        width: options.width,
        height: options.height,
      },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout ?? DEFAULT_TIMEOUT);

    const input = normalizeInput(options.input);
    await page.goto(input, {
      waitUntil: "load",
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });

    const engine = await detectEngine(page);
    if (!engine) {
      throw new Error(
        "Could not detect a supported slide framework " +
          "(reveal.js or remark.js)",
      );
    }

    await engine.waitForReady(page, options.timeout);
    await engine.installMeasurement(page);
    await waitForAssets(page);
    await addDisableAnimationsCss(page);
    if (engine.configure) {
      await engine.configure(page);
    }
    await engine.layout(page);

    const browserInfo = await getBrowserInfo(page);
    const geometry = await engine.getGeometry(page);
    const slides = await engine.getSlides(page);
    const results = [];

    for (const slide of slides) {
      const result = await inspectSlide(page, engine, slide, options);
      results.push(result);
      if (result.overflow && options.screenshots) {
        await saveScreenshot(page, result, options.screenshots);
      }
    }

    const overflowSlides = results.filter((slide) => slide.overflow);

    return {
      input,
      framework: engine.name,
      browser: browserInfo,
      geometry,
      threshold: options.threshold,
      fragments: options.fragments,
      slideCount: results.length,
      overflowCount: overflowSlides.length,
      failed: overflowSlides.length > 0,
      slides: results,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Identify which slide framework the page uses.
 */
async function detectEngine(page) {
  for (const engine of ENGINES) {
    if (await engine.detect(page)) {
      return engine;
    }
  }

  return null;
}

/**
 * Inspect one slide.
 */
async function inspectSlide(page, engine, slideInfo, options) {
  /* Navigate to the slide using the engine. */
  await engine.gotoSlide(page, slideInfo);
  await waitForStableLayout(page, engine, options.wait ?? 100);

  /* Measure ordinary slide state. */
  const normal = await engine.measureCurrentSlide(page, options.threshold);

  /* Measure with all fragments visible. */
  let fragmentState = null;
  if (options.fragments && engine.measureFragments) {
    fragmentState = await engine.measureFragments(page, options.threshold);
  }

  const combined = combineMeasurements(normal, fragmentState);

  const result = {
    index: slideInfo.index,
    label: slideInfo.label ?? slideLabel(slideInfo),
    id: slideInfo.id ?? null,
    overflow: combined.overflow,
    horizontalOverflow: combined.horizontalOverflow,
    verticalOverflow: combined.verticalOverflow,
    leftOverflow: combined.leftOverflow,
    rightOverflow: combined.rightOverflow,
    topOverflow: combined.topOverflow,
    bottomOverflow: combined.bottomOverflow,
    slideWidth: combined.slideWidth,
    slideHeight: combined.slideHeight,
    renderedWidth: combined.renderedWidth,
    renderedHeight: combined.renderedHeight,
    scaleX: combined.scaleX,
    scaleY: combined.scaleY,
    scrollWidth: combined.scrollWidth,
    scrollHeight: combined.scrollHeight,
    elements: combined.elements,
  };

  if (slideInfo.h !== undefined) {
    result.h = slideInfo.h;
    result.v = slideInfo.v;
  }

  if (slideInfo.dataId !== undefined) {
    result.dataId = slideInfo.dataId;
  }

  if (fragmentState) {
    result.fragmentOverflow = fragmentState.overflow;
  }

  return result;
}

/**
 * Wait for the engine to perform layout and for browser rendering to
 * settle.
 */
async function waitForStableLayout(page, engine, wait) {
  await engine.layout(page);

  await page.evaluate(() => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  });

  if (wait > 0) {
    await sleep(wait);
  }
}
