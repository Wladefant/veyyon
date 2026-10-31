# Changelog

## [Unreleased]

### Added

- The web plugin exports a bounded public-fetch handler that validates destinations and takes caller identity only from the host authorize function ([Refs #629](https://github.com/Wladefant/veyyon/issues/629)).

## [1.6.0] - 2026-10-28

### Added

- The DeepSeek Fetch client reads one page through `https://api.deepseek.com/v1/tools/fetch` and returns its title and Markdown body, using the DeepSeek API key the coding agent already stores.
- The public search handler `createPublicSearchHandler` runs `POST` `{query}` through Brave Web Search for each identity its injected `authorize` dependency admits, requires the host's server-side auth, admission and Brave key dependencies, and is not mounted on a route yet; its in-memory per-user cap (5 a rolling minute, 500 a UTC month, 2,500,000 microusd a UTC month) resets on restart and is kept per instance.

### Changed

- Sync upstream changes from santhreal/veyyon.
- The page loader, the declarative and academic-paper engines, and the GitHub, Bluesky, YouTube, Twitter and Sourcegraph handlers are split into one function per step; behavior is unchanged.
- The bioRxiv, Crossref, ORCID, PubMed, RFC and Semantic Scholar handlers are split into one function per step; behavior is unchanged.
- The Reddit, Lobsters, Lemmy, Discourse, dev.to and Stack Exchange handlers are split into one function per step; behavior is unchanged.
- The Artifact Hub, Homebrew, Chocolatey, Clojars, Docker Hub, Firefox Add-ons, Flathub, Go, Hex, JetBrains Marketplace, npm, NuGet, Open VSX, Packagist, pub.dev, PyPI, Repology, Snapcraft, Terraform and VS Code Marketplace handlers are split into one function per step; behavior is unchanged.
- The NVD and OSV handlers are split into one function per step, and the Terraform, pub.dev and NVD capped lists share one section renderer; behavior is unchanged.
- The MDN, Open Library, Read the Docs, W3C, Wikidata and Wikipedia handlers are split into one function per step; behavior is unchanged.
- The MusicBrainz and Spotify handlers are split into one function per step; behavior is unchanged.
- The Mastodon and Ollama handlers are split into one function per step; behavior is unchanged.

### Fixed

- The Hugging Face handler omits a model field the API returns as `null` or as an empty list, and renders a single-segment model path such as `huggingface.co/gpt2` with the same fields as an `org/model` path.
- The GitLab handler decodes percent-encoded path segments before it builds an API URL, and reads a project README from its raw URL instead of the HTML blob page.
- The docs.rs handler reads rustdoc JSON format 61, lists only public items, resolves an item page by its kind so `macro.make.html` and `fn.make.html` render different items, and degrades when the compressed document exceeds the size cap.
- The CoinGecko handler renders a coin whose price, 24h change or all-time high the API returns as `null` instead of falling back to a generic fetch, and drops blank category names; the OpenCorporates and Searchcode renderers are split into one function per section with unchanged output.
- The RFC handler renders the authors, current status, source and DOI from the field names the RFC Editor JSON record uses, instead of a blank author list and no status.
- The PubMed handler takes its fallback DOI from the `doi:` entry of the electronic location ids, instead of rendering the whole field, `doi:` prefix or PII included, as the DOI.
- The Lobsters handler renders the flat comment list the API returns, indented by each comment's depth and as its Markdown source instead of HTML, and shows a link story's description beside its link.
- The Lemmy handler threads replies by the ancestry in each comment's `path`, instead of listing every reply at the top level.
- The Discourse handler reads post likes from `actions_summary` and tag names from tag records, as current Discourse releases return them, instead of rendering 0 likes and `[object Object]` tags.
- The dev.to handler renders an article page, for which the API returns `tag_list` as a comma-separated string, instead of failing on it.
- The Stack Exchange handler decodes HTML entities in the question title and in author names.
- The Hacker News handler renders the text of a comment that has replies once instead of twice.
- The Wikidata handler counts only sitelinks to Wikipedia as Wikipedia articles, instead of every Wikiquote, Wikisource and Commons link as well.
- The Wikidata handler renders a quantity with its unit label, such as `1.96 metre`, and requests the label of every value it shows, instead of the first 50 entity values in claim order.
- The Wikipedia handler renders each paragraph once, under the innermost section that holds it, and drops the subsections of a skipped section such as See also.
- The Read the Docs handler reports a converted page as `text/markdown`, instead of `text/html`, or `text/plain` after a failed raw-source fetch.
- The Open Library handler looks up a 13-digit ISBN by all 13 digits, instead of its first 10, and accepts an ISBN-10 whose check digit is `X`.
- The Wikidata handler renders a merged item as the item it redirects to, with a `Redirected from` line, instead of falling back to a generic fetch.

## [1.5.6] - 2026-10-10

### Removed

- Removed the `stackoverflowDeclaration` alias; import `stackOverflowDeclaration`.
- Removed the `formatNumber` and `htmlToBasicMarkdown` re-exports from `scrapers/types`; import them from `@veyyon/utils/format` and `@veyyon/utils/html-markdown`.

### Changed

- Replaced `any` types in `getNested` scraper utility with `unknown` and preserved user cancellation on scrapers.
- Firecrawl endpoint normalization strips trailing slashes through the shared `trimTrailingSlashes` helper; no behavior change.
- The marketplace repository-link reader, key-value renderer and package-registry handler test missing values with optional chains; behavior is unchanged.

## [1.5.4] - 2026-09-24

### Changed

- Replaced `any` types in `getNested` scraper utility with `unknown`; no user-visible behavior change.

### Fixed

- Re-throw caller cancellation in GitHub and Mastodon scrapers so user abort signals are not swallowed and fallen back to generic fetch.

## [1.5.0] - 2026-09-18

### Added

- The site scrapers behind the `fetch` tool are their own package: 79 site handlers, the shared page loader and the Parallel extraction client, moved out of `@veyyon/coding-agent` unchanged.
- A scraper states the host capabilities it needs through `ScrapeServices` — the credential store, document conversion, external-tool resolution, the session spawn hook and the fetch-provider preference — instead of importing the agent's settings, storage and process modules.

### Changed

- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- The Hugging Face handler fetches a model, dataset or space record and its README through one `loadHfResource`, and the YouTube handler downloads the manual and auto-generated subtitle tracks through one `downloadSubtitleText`; no behavior change.
- Consolidated specialized web scraper site handlers into parameterized domain engines and declarative site definitions.
- The Discourse handler trims its base path with `trimTrailingSlashes` from `@veyyon/utils/url` rather than its own inline strip. No user-visible behavior changes.
- Business, media, documentation, discussion and security-advisory handlers share dispatch without changing host matching or scrape results.
- Package-registry scrapers share Markdown section assembly without changing rendered results.
- Academic-paper, license and discussion scrapers share PDF conversion and Markdown assembly without changing site-specific output.
- Package-registry, academic-paper and declarative scrapers omit unused metadata fallbacks while preserving request headers and failure handling.
- Package-registry and academic-paper handlers share URL dispatch while preserving callback receivers and request-local notes.
