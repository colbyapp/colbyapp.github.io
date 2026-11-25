// Turns GitHub's generated release notes (the body `gh release create --generate-notes` writes) into the short list
// Settings shows. Used by build.mjs on a `web-vX.Y.Z` tag.

const ITEM = /^\* (.+?) by @\S+ in (https:\/\/\S+\/pull\/\d+)\s*$/;
const OTHER_APP = /^(mac|macos|windows|ci)\s*:/i; // PRs for the desktop apps or CI only; this list is the web app's

/** `[{title, url}]` from the "What's Changed" list; desktop-only and CI-only PRs are left out, a `Web:` prefix dropped. */
export function parseReleaseNotes(body) {
  const items = [];
  let inChanges = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (line.startsWith('## ')) inChanges = /what's changed/i.test(line);
    if (!inChanges) continue;
    const m = ITEM.exec(line);
    if (!m || OTHER_APP.test(m[1])) continue;
    const title = m[1].replace(/^web\s*:\s*/i, '');
    items.push({ title: title.charAt(0).toUpperCase() + title.slice(1), url: m[2] });
  }
  return items;
}

/** The release baked into the bundle, or null for a build that is not from a release tag. */
export function releaseInfo({ tag, notesBody, date = new Date() }) {
  if (!tag || !/^web-v\d/.test(tag)) return null;
  return { version: tag.slice('web-v'.length), date: date.toISOString().slice(0, 10), notes: parseReleaseNotes(notesBody) };
}
