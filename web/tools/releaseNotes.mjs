const ITEM = /^\* (.+?) by @\S+ in (https:\/\/\S+\/pull\/\d+)\s*$/;
/** A hand-written bullet ("- text" or "* text"), for release notes written on the release page instead of generated. */
const PLAIN = /^[-*] (.+?)\s*$/;
const OTHER_APP = /^(mac|macos|windows|ci)\s*:/i; // PRs for the desktop apps or CI only; this list is the web app's

/**
 * `[{title, url}]` from the "What's Changed" list; desktop-only and CI-only items are left out, a `Web:` prefix dropped.
 * Takes GitHub's generated items (`* title by @user in <PR url>`) and hand-written bullets (url null).
 */
export function parseReleaseNotes(body) {
  const items = [];
  let inChanges = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (line.startsWith('## ')) inChanges = /what's changed/i.test(line);
    if (!inChanges) continue;
    const m = ITEM.exec(line);
    const text = m ? m[1] : PLAIN.exec(line)?.[1];
    if (!text || OTHER_APP.test(text)) continue;
    const title = text.replace(/^web\s*:\s*/i, '');
    items.push({ title: title.charAt(0).toUpperCase() + title.slice(1), url: m ? m[2] : null });
  }
  return items;
}

/** The release baked into the bundle, or null for a build that is not from a release tag. */
export function releaseInfo({ tag, notesBody, date = new Date() }) {
  if (!tag || !/^web-v\d/.test(tag)) return null;
  return { version: tag.slice('web-v'.length), date: date.toISOString().slice(0, 10), notes: parseReleaseNotes(notesBody) };
}
