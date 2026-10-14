# slides-overflow

Check [reveal.js](https://revealjs.com/) and [remark.js](https://remarkjs.com/)
slides for overflowing content.

## Setup

- `git clone`
- `npm install`
- `npx playwright install chromium`
- `npm link`
- `slides-overflow /path/to/slides.html`

## Options

```
Options:
  --threshold <px>       Allowed overflow in pixels (default: 1)
  --width <px>           Browser viewport width (default: 1280)
  --height <px>          Browser viewport height (default: 720)
  --timeout <ms>         Page/load timeout (default: 30000)
  --wait <ms>            Additional layout wait (default: 100)
  --fragments            Check with all fragments visible (default)
  --no-fragments         Do not check fragments
  --screenshots <dir>    Save screenshots of overflowing slides
  --json                 Output JSON
  --quiet                Only output failures
  --fail                 Exit 1 if overflow is found
  --help                 Show this help
```

The framework is detected automatically from the page: if `Reveal` is present the
deck is treated as reveal.js, otherwise a deck rendered with `remark.create()` is
treated as remark.js.

## Notes on remark.js

- Slides are numbered from 1 in reports, matching remark.js's own numbering.
- Incremental slides (`--` in the source) are merged into a single logical
  slide and checked with all increments visible, mirroring the reveal.js
  fragment behavior.
- Navigation uses remark.js's URL-hash interface, so this works for
  full-page remark decks (the default `remark.create()` usage).
