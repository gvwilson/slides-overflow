import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT = 30_000;

/**
 * Convert a local path into a file:// URL.
 * Leave HTTP(S) and file URLs untouched.
 */
export function normalizeInput(input) {
  if (
    input.startsWith("http://") ||
    input.startsWith("https://") ||
    input.startsWith("file://")
  ) {
    return input;
  }

  return pathToFileURL(path.resolve(input)).href;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get actual browser viewport information.
 */
export async function getBrowserInfo(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
}

/**
 * Wait for fonts, images, and browser layout.
 */
export async function waitForAssets(page) {
  await page.evaluate(async () => {
    /* Fonts. */
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    /* Images. */
    const images = [...document.images];
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) {
          try {
            await image.decode?.();
          } catch {
            // Broken images can still be measured.
          }
          return;
        }

        await new Promise((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        });

        try {
          await image.decode?.();
        } catch {
          // Ignore decode errors.
        }
      }),
    );

    /* Give browser layout two animation frames to settle. */
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  });
}

/**
 * Disable animations/transitions so measurements are deterministic.
 */
export async function addDisableAnimationsCss(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `,
  });
}

/**
 * Install the generic overflow scan in the browser context.
 *
 * The scan itself is engine-agnostic.  The active engine must install
 * `window.__overflowGeometry(slide)` and `window.__overflowExclude`
 * before any slide is measured.
 */
export async function installMeasurement(page) {
  await page.evaluate(() => {
    window.__overflowMeasure = function (slide, threshold, mode = "normal") {
      if (typeof window.__overflowGeometry !== "function") {
        throw new Error("Overflow geometry provider was not installed");
      }

      const geometry = window.__overflowGeometry(slide);
      const slideWidth = geometry.slideWidth;
      const slideHeight = geometry.slideHeight;
      const scaleX = geometry.scaleX;
      const scaleY = geometry.scaleY;
      const referenceLeft = geometry.referenceLeft;
      const referenceTop = geometry.referenceTop;
      const exclude = window.__overflowExclude ?? "";

      function round(value) {
        return Math.round(value * 10) / 10;
      }

      function elementText(el) {
        const text = el.textContent?.replace(/\s+/g, " ").trim();

        if (!text) {
          return "";
        }

        return text.length > 120 ? `${text.slice(0, 117)}...` : text;
      }

      function describeElement(el) {
        const tag = el.tagName.toLowerCase();

        if (el.id) {
          return `${tag}#` + CSS.escape(el.id);
        }

        const classes = [...el.classList]
          .filter(Boolean)
          .slice(0, 3)
          .map((c) => `.${CSS.escape(c)}`)
          .join("");

        let selector = `${tag}${classes}`;

        if (el.parentElement) {
          const siblings = [...el.parentElement.children];
          const index = siblings.indexOf(el) + 1;
          selector += `:nth-child(${index})`;
        }

        return selector;
      }

      function isMeasurableElement(el) {
        if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) {
          return false;
        }

        /* Skip presentation infrastructure. */
        if (exclude && el.matches(exclude)) {
          return false;
        }

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }

        /* Elements inside excluded ancestors are also ignored. */
        if (exclude && el.closest(exclude)) {
          return false;
        }

        const rect = el.getBoundingClientRect();

        return rect.width > 0 || rect.height > 0;
      }

      /*
       * Convert an element's browser-space rectangle into the slide's
       * native coordinate system.
       */
      function toSlideRect(el) {
        const rect = el.getBoundingClientRect();

        return {
          left: (rect.left - referenceLeft) / scaleX,
          right: (rect.right - referenceLeft) / scaleX,
          top: (rect.top - referenceTop) / scaleY,
          bottom: (rect.bottom - referenceTop) / scaleY,
          width: rect.width / scaleX,
          height: rect.height / scaleY,
        };
      }

      let leftOverflow = 0;
      let rightOverflow = 0;
      let topOverflow = 0;
      let bottomOverflow = 0;

      const elements = [];

      /* Check every rendered descendant. */
      for (const el of slide.querySelectorAll("*")) {
        if (!isMeasurableElement(el)) {
          continue;
        }

        const rect = toSlideRect(el);
        const left = Math.max(0, -rect.left);
        const right = Math.max(0, rect.right - slideWidth);
        const top = Math.max(0, -rect.top);
        const bottom = Math.max(0, rect.bottom - slideHeight);

        leftOverflow = Math.max(leftOverflow, left);
        rightOverflow = Math.max(rightOverflow, right);
        topOverflow = Math.max(topOverflow, top);
        bottomOverflow = Math.max(bottomOverflow, bottom);

        const horizontal = Math.max(left, right);
        const vertical = Math.max(top, bottom);

        if (horizontal > threshold || vertical > threshold) {
          elements.push({
            selector: describeElement(el),
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: typeof el.className === "string" ? el.className : null,
            text: elementText(el),
            left: round(rect.left),
            top: round(rect.top),
            width: round(rect.width),
            height: round(rect.height),
            horizontalOverflow: round(horizontal),
            verticalOverflow: round(vertical),
            mode,
          });
        }
      }

      /*
       * scrollWidth / scrollHeight are expressed in the element's CSS
       * coordinate system, which already matches the native slide
       * coordinate system.
       */
      const scrollWidth = slide.scrollWidth;
      const scrollHeight = slide.scrollHeight;
      const scrollWidthOverflow = Math.max(0, scrollWidth - slideWidth);
      const scrollHeightOverflow = Math.max(0, scrollHeight - slideHeight);
      const horizontalOverflow = Math.max(
        leftOverflow,
        rightOverflow,
        scrollWidthOverflow,
      );
      const verticalOverflow = Math.max(
        topOverflow,
        bottomOverflow,
        scrollHeightOverflow,
      );

      /* Sort worst offenders first. */
      elements.sort((a, b) => {
        const aMax = Math.max(a.horizontalOverflow, a.verticalOverflow);
        const bMax = Math.max(b.horizontalOverflow, b.verticalOverflow);
        return bMax - aMax;
      });

      const overflow =
        horizontalOverflow > threshold || verticalOverflow > threshold;

      return {
        overflow,
        horizontalOverflow: round(horizontalOverflow),
        verticalOverflow: round(verticalOverflow),
        leftOverflow: round(leftOverflow),
        rightOverflow: round(rightOverflow),
        topOverflow: round(topOverflow),
        bottomOverflow: round(bottomOverflow),
        scrollWidth: round(scrollWidth),
        scrollHeight: round(scrollHeight),
        slideWidth: round(slideWidth),
        slideHeight: round(slideHeight),
        renderedWidth: round(slideWidth * scaleX),
        renderedHeight: round(slideHeight * scaleY),
        scaleX: round(scaleX),
        scaleY: round(scaleY),
        elements,
      };
    };
  });
}

/**
 * Combine normal and fragment measurements.
 */
export function combineMeasurements(normal, fragments) {
  if (!fragments) {
    return normal;
  }

  return {
    overflow: normal.overflow || fragments.overflow,
    horizontalOverflow: Math.max(
      normal.horizontalOverflow,
      fragments.horizontalOverflow,
    ),
    verticalOverflow: Math.max(
      normal.verticalOverflow,
      fragments.verticalOverflow,
    ),
    leftOverflow: Math.max(normal.leftOverflow, fragments.leftOverflow),
    rightOverflow: Math.max(normal.rightOverflow, fragments.rightOverflow),
    topOverflow: Math.max(normal.topOverflow, fragments.topOverflow),
    bottomOverflow: Math.max(normal.bottomOverflow, fragments.bottomOverflow),
    slideWidth: normal.slideWidth,
    slideHeight: normal.slideHeight,
    renderedWidth: normal.renderedWidth,
    renderedHeight: normal.renderedHeight,
    scaleX: normal.scaleX,
    scaleY: normal.scaleY,
    scrollWidth: Math.max(normal.scrollWidth, fragments.scrollWidth),
    scrollHeight: Math.max(normal.scrollHeight, fragments.scrollHeight),
    elements: dedupeElements([...normal.elements, ...fragments.elements]),
  };
}

/**
 * Remove duplicate element reports.
 */
export function dedupeElements(elements) {
  const seen = new Set();

  return elements.filter((element) => {
    const key = [
      element.selector,
      element.horizontalOverflow,
      element.verticalOverflow,
      element.mode,
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * Save a screenshot of an overflowing slide.
 */
export async function saveScreenshot(page, result, directory) {
  await fs.mkdir(directory, {
    recursive: true,
  });

  const filename = `slide-${String(result.index).padStart(3, "0")}.png`;

  await page.screenshot({
    path: path.join(directory, filename),
  });
}

/**
 * Human-readable slide number.
 */
export function slideLabel(slide) {
  if (slide.v > 0) {
    return `${slide.h + 1}.${slide.v}`;
  }

  return `${slide.h + 1}`;
}
