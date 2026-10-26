# AGENTS.md

A TRMNL private plugin (plugin setting **520302**, framework 3.4.4) showing the NWS Weather Story for a location: the graphics a forecast office posts to explain the coming weather. It replaces `../wxstory`, a Cloudflare Worker that scraped the same pages.

## Data flow

- **Strategy:** `polling`, URL `https://api.weather.gov/points/{{ location }}`. TRMNL follows the API's 301 for points given to more than 4 decimals. Points outside NWS coverage answer 404.
- **Transform:** `serverless.js`, uploaded to the `transform_js` slot (serverless Node runtime, `run(input)`). The office is `properties.cwa`, not `gridId`: Anchorage answers `cwa: AFC`, `gridId: AER`. A failed poll is refetched with the point rounded to 4 decimals.
- **Pages:** offices post stories at `/{office}/weatherstory` or on their home page `/{office}/`, so the transform tries the page that last had stories, then the other. Paths are case-insensitive and neither redirects. Some offices post no stories at all; the screen says so.
- **Images:** a HEAD request gives `Last-Modified`, shown as the update time and appended as `?v=`. Offices overwrite the same file name, so the version is what changes the merge variables when the graphic changes. `graphicast/smallN.png` is a 725x408 thumbnail of `graphicast/N.png`; the transform uses the full size when it exists.
- **Saved state:** `trmnl_state` is `{ location, office, page, next }`. It skips the points lookup when the API is down, sends the next run to the right page first, and drives rotation.
- **Output:** `{ office, story, count, error, trmnl_state }`. `story` carries `title`, `description`, `image`, `updated` (ISO-8601) and `number`.
- All requests share a 4.5 s budget under the 5 s run limit.

## weather.gov page structure

- Stories live in a tab widget: `<div id="tabs" class="c-tabs">`, titles in `.c-tabs-nav__link span`, and each `.c-tab` holds `.graphicast > .image img` plus `.description`. Nothing outside the widget counts: home pages carry a sidebar `wxstory` thumbnail that can be stale.
- Offices without stories render an empty widget or none.
- Descriptions can contain emoji, which ePaper fonts lack; the transform strips them.
- Albuquerque, Lubbock, San Juan and Tampa Bay include an animated radar loop from radar.weather.gov as a tab; Albuquerque and Lubbock lead with it. The transform keeps it.

## Custom fields

`custom_fields.yml` holds `author_bio`, `location` (`lat_lon`, default Grand Rapids), `story` (`lead` or `rotate`) and `timemode`. Field values cannot be written through the TRMNL API. TRMNL applies defaults at run time without storing them, and does not poll while a required field has no value.

## Templates

All markup is in `shared.liquid`; each size file is one `{% render 'main', ... %}`. Partials: `main`, `title_bar`. Framework classes only.

- Graphics carry `image image-dither image--contain`. `image-dither` is a marker that TRMNL's render pipeline acts on; the framework CSS does not dither. Local `trmnlp` PNGs are its own 1-bit conversion.
- `full` is the graphic alone; in portrait the description follows it. `half_horizontal` puts the description beside the graphic, `half_vertical` below it. `quadrant` is the graphic alone.
- The title bar shows `NWS {office}` as the title and `{story title} · n of N · Updated …` as the instance. The instance is dropped on `half_vertical`, `quadrant` and portrait screens, where it clips. `n of N` appears only while rotating.
- The update time is a clock time when it is today and a date before that, computed in Liquid with `date: '%s' | plus: trmnl.user.utc_offset`.
- The title bar logo is the inline NWS SVG from `../trmnl-nws-severe-weather`.

## Deploying

There is no CLI sync. Push each file through the TRMNL MCP `writeMarkup` (`markup_shared`, `markup_full`, `markup_half_horizontal`, `markup_half_vertical`, `markup_quadrant`, `transform_js`), then `startRefresh`. `updatePluginSettingFields` sets `polling_url` and `custom_fields`.

- `writeMarkup` on `transform_js` can answer a `transform_error` about `localhost:8181` while the save still lands. Judge the transform by `startRefresh`.
- The transform linter rejects a literal `return []`, even in a helper.
