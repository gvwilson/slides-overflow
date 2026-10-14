import {
  DEFAULT_TIMEOUT,
  installMeasurement as installSharedMeasurement,
} from "../shared.js";

export const name = "reveal";

export async function detect(page) {
  return page.evaluate(() => {
    return !!(window.Reveal && typeof window.Reveal.getSlides === "function");
  });
}

/**
 * Wait for reveal.js itself to be available and ready.
 */
export async function waitForReady(page, timeout) {
  const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT;

  await page.waitForFunction(
    () => {
      return window.Reveal && typeof window.Reveal.getSlides === "function";
    },
    null,
    { timeout: effectiveTimeout },
  );

  await page.waitForFunction(
    () => {
      return (
        window.Reveal.isReady?.() === true ||
        document.querySelector(".reveal.ready") !== null
      );
    },
    null,
    { timeout: effectiveTimeout },
  );
}

/**
 * Install the shared scan plus the reveal.js geometry provider.
 */
export async function installMeasurement(page) {
  await page.evaluate(() => {
    window.__overflowExclude =
      ".backgrounds, .background, .speaker-notes, .progress, .controls";

    window.__overflowGeometry = function (slide) {
      /*
       * Use reveal.js's native slide size instead of the transformed
       * browser rectangle as our coordinate system.
       */
      const computed = window.Reveal.getComputedSlideSize();
      const slideWidth = Number(computed.width);
      const slideHeight = Number(computed.height);
      if (
        !Number.isFinite(slideWidth) ||
        !Number.isFinite(slideHeight) ||
        slideWidth <= 0 ||
        slideHeight <= 0
      ) {
        throw new Error(
          `Invalid reveal.js slide size: ` +
            `${computed.width} × ${computed.height}`,
        );
      }

      /*
       * Reveal.js scales the native slide to fit the browser viewport,
       * so convert browser coordinates back into native reveal slide
       * coordinates.
       */
      const slideRect = slide.getBoundingClientRect();
      const scaleX = slideRect.width / slideWidth;
      const scaleY = slideRect.height / slideHeight;
      if (
        !Number.isFinite(scaleX) ||
        !Number.isFinite(scaleY) ||
        scaleX <= 0 ||
        scaleY <= 0
      ) {
        throw new Error(`Invalid reveal.js scale: ` + `${scaleX} × ${scaleY}`);
      }

      return {
        slideWidth,
        slideHeight,
        scaleX,
        scaleY,
        referenceLeft: slideRect.left,
        referenceTop: slideRect.top,
      };
    };
  });

  await installSharedMeasurement(page);
}

/**
 * Apply reveal.js-specific configuration for deterministic measurement.
 */
export async function configure(page) {
  await page.evaluate(() => {
    if (window.Reveal?.configure) {
      window.Reveal.configure({
        transition: "none",
        backgroundTransition: "none",
        controls: false,
        progress: false,
        slideNumber: false,
        keyboard: false,
        overview: false,
      });
    }
  });
}

export async function layout(page) {
  await page.evaluate(() => {
    window.Reveal.layout();
  });
}

/**
 * Get reveal.js's current presentation geometry.
 */
export async function getGeometry(page) {
  return page.evaluate(() => {
    const size = window.Reveal.getComputedSlideSize();

    return {
      slideWidth: Number(size.width),
      slideHeight: Number(size.height),
      scale: Number(window.Reveal.getScale()),
      indices: window.Reveal.getIndices(),
    };
  });
}

/**
 * Return all slides known to reveal.js.
 */
export async function getSlides(page) {
  return page.evaluate(() => {
    return window.Reveal.getSlides().map((slide, index) => {
      const indices = window.Reveal.getIndices(slide);

      return {
        index,
        h: indices.h,
        v: indices.v ?? 0,
        f: indices.f ?? 0,
        id: slide.id || null,
        dataId: slide.dataset?.id || null,
        notes: !!slide.querySelector("aside.notes"),
      };
    });
  });
}

/**
 * Navigate to a slide using reveal.js.
 */
export async function gotoSlide(page, slideInfo) {
  await page.evaluate(({ h, v }) => {
    window.Reveal.slide(h, v, -1);
    window.Reveal.layout();
  }, slideInfo);
}

/**
 * Measure the current slide.
 */
export async function measureCurrentSlide(page, threshold) {
  return page.evaluate(
    ({ threshold }) => {
      const slide = window.Reveal.getCurrentSlide();
      if (!slide) {
        throw new Error("Reveal.js has no current slide");
      }

      if (typeof window.__overflowMeasure !== "function") {
        throw new Error("Overflow measurement function was not installed");
      }

      return window.__overflowMeasure(slide, threshold, "normal");
    },
    { threshold },
  );
}

/**
 * Measure with all fragments visible.
 */
export async function measureFragments(page, threshold) {
  return page.evaluate(
    async ({ threshold }) => {
      const slide = window.Reveal.getCurrentSlide();
      if (!slide) {
        return null;
      }

      const fragments = [...slide.querySelectorAll(".fragment")];
      if (fragments.length === 0) {
        return {
          overflow: false,
          horizontalOverflow: 0,
          verticalOverflow: 0,
          leftOverflow: 0,
          rightOverflow: 0,
          topOverflow: 0,
          bottomOverflow: 0,
          slideWidth: window.Reveal.getComputedSlideSize().width,
          slideHeight: window.Reveal.getComputedSlideSize().height,
          renderedWidth: slide.getBoundingClientRect().width,
          renderedHeight: slide.getBoundingClientRect().height,
          scaleX: window.Reveal.getScale(),
          scaleY: window.Reveal.getScale(),
          scrollWidth: slide.scrollWidth,
          scrollHeight: slide.scrollHeight,
          elements: [],
        };
      }

      /* Save exact fragment state. */
      const original = fragments.map((el) => ({
        className: el.className,
        style: el.getAttribute("style"),
      }));

      /* Force every fragment visible. */
      for (const el of fragments) {
        el.classList.remove("visible", "current-fragment");
        el.classList.add("visible");
        el.style.setProperty("visibility", "visible", "important");
        el.style.setProperty("opacity", "1", "important");
      }

      /* Allow layout to settle. */
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      let measurement;
      try {
        measurement = window.__overflowMeasure(slide, threshold, "fragment");
      } finally {
        /* Always restore original state, even if measurement throws. */
        fragments.forEach((el, index) => {
          el.className = original[index].className;
          if (original[index].style === null) {
            el.removeAttribute("style");
          } else {
            el.setAttribute("style", original[index].style);
          }
        });
      }

      return measurement;
    },
    { threshold },
  );
}
