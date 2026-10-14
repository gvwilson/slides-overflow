import {
  DEFAULT_TIMEOUT,
  installMeasurement as installSharedMeasurement,
} from "../shared.js";

export const name = "remark";

export async function detect(page) {
  return page.evaluate(() => {
    return !!(document.querySelector(".remark-slide") || window.remark);
  });
}

/**
 * Wait for remark.js to render its slides.
 */
export async function waitForReady(page, timeout) {
  const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT;

  await page.waitForFunction(
    () => {
      return (
        document.querySelectorAll(".remark-slides-area .remark-slide").length >
        0
      );
    },
    null,
    { timeout: effectiveTimeout },
  );
}

/**
 * Install the shared scan plus the remark.js geometry provider.
 *
 * remark.js renders every slide inside a fixed-size `.remark-slide-scaler`
 * that is transformed to fit the viewport.  The scaler is the reference
 * box: content may overflow it even though the slide element itself can
 * grow to fit its content.
 */
export async function installMeasurement(page) {
  await page.evaluate(() => {
    window.__overflowExclude = ".remark-slide-number, .remark-slide-notes";

    window.__overflowGeometry = function (slide) {
      const scaler = slide.closest(".remark-slide-scaler");
      if (!scaler) {
        throw new Error("remark.js slide has no scaler");
      }

      const computed = window.getComputedStyle(scaler);
      const slideWidth = parseFloat(computed.width);
      const slideHeight = parseFloat(computed.height);
      if (
        !Number.isFinite(slideWidth) ||
        !Number.isFinite(slideHeight) ||
        slideWidth <= 0 ||
        slideHeight <= 0
      ) {
        throw new Error(
          `Invalid remark.js slide size: ` +
            `${computed.width} × ${computed.height}`,
        );
      }

      const scalerRect = scaler.getBoundingClientRect();
      const scaleX = scalerRect.width / slideWidth;
      const scaleY = scalerRect.height / slideHeight;
      if (
        !Number.isFinite(scaleX) ||
        !Number.isFinite(scaleY) ||
        scaleX <= 0 ||
        scaleY <= 0
      ) {
        throw new Error(`Invalid remark.js scale: ` + `${scaleX} × ${scaleY}`);
      }

      return {
        slideWidth,
        slideHeight,
        scaleX,
        scaleY,
        referenceLeft: scalerRect.left,
        referenceTop: scalerRect.top,
      };
    };
  });

  await installSharedMeasurement(page);
}

/**
 * remark.js needs no extra configuration; the shared CSS already
 * disables animations.
 */
export async function layout() {
  /* No-op: remark.js lays out the current slide on navigation. */
}

/**
 * Get remark.js's current presentation geometry.
 */
export async function getGeometry(page) {
  return page.evaluate(() => {
    const slide = document.querySelector(".remark-slides-area .remark-slide");
    const scaler = slide?.closest(".remark-slide-scaler");
    if (!scaler) {
      return { slideWidth: 0, slideHeight: 0, scale: 1 };
    }

    const computed = window.getComputedStyle(scaler);
    const slideWidth = parseFloat(computed.width);
    const slideHeight = parseFloat(computed.height);
    const rect = scaler.getBoundingClientRect();
    const scale = slideWidth > 0 ? rect.width / slideWidth : 1;

    return { slideWidth, slideHeight, scale };
  });
}

/**
 * Return the logical slides in a remark.js deck.
 *
 * Incremental slides (`--` in the source) are rendered as separate DOM
 * slides whose content accumulates.  Consecutive slides sharing the same
 * heading id are merged into one logical slide; the last (fullest) of
 * them is measured.
 */
export async function getSlides(page) {
  return page.evaluate(() => {
    const slides = [
      ...document.querySelectorAll(".remark-slides-area .remark-slide"),
    ];

    function slideNumber(slide) {
      const badge = slide.querySelector(".remark-slide-number");
      const match = badge?.textContent?.match(/^\s*(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }

    function headingId(slide) {
      const heading = slide.querySelector(
        ".remark-slide-content h1, " +
          ".remark-slide-content h2, " +
          ".remark-slide-content h3, " +
          ".remark-slide-content h4, " +
          ".remark-slide-content h5, " +
          ".remark-slide-content h6",
      );
      return heading?.id || null;
    }

    const groups = [];

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const id = headingId(slide);
      const previous = groups[groups.length - 1];

      if (previous && id !== null && previous.id === id) {
        previous.lastIndex = i;
      } else {
        groups.push({
          id,
          label: slideNumber(slide) ?? i + 1,
          firstIndex: i,
          lastIndex: i,
        });
      }
    }

    return groups.map((group) => ({
      index: group.lastIndex,
      number: group.lastIndex + 1,
      label: String(group.label),
      id: group.id,
    }));
  });
}

/**
 * Navigate to a slide using remark.js's location-hash interface.
 *
 * remark.js numbers slides from 1 in its URL hash.  After changing the
 * hash we wait for the target slide's container to become visible.
 */
export async function gotoSlide(page, slideInfo) {
  await page.evaluate((number) => {
    window.location.hash = String(number);
  }, slideInfo.number);

  await page.waitForFunction((index) => {
    const slides = document.querySelectorAll(
      ".remark-slides-area .remark-slide",
    );
    const slide = slides[index];
    if (!slide) {
      return false;
    }

    const container = slide.closest(".remark-slide-container");
    return (
      container.classList.contains("remark-visible") &&
      slide.getBoundingClientRect().width > 0
    );
  }, slideInfo.index);
}

/**
 * Measure the current (visible) slide.
 */
export async function measureCurrentSlide(page, threshold) {
  return page.evaluate(
    ({ threshold }) => {
      const slide = document.querySelector(
        ".remark-slides-area " +
          ".remark-slide-container.remark-visible .remark-slide",
      );
      if (!slide) {
        throw new Error("remark.js has no current slide");
      }

      if (typeof window.__overflowMeasure !== "function") {
        throw new Error("Overflow measurement function was not installed");
      }

      return window.__overflowMeasure(slide, threshold, "normal");
    },
    { threshold },
  );
}
