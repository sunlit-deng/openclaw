export function prUpdateRequired({ currentBody, currentTitle, nextBody, nextTitle = "" }) {
  const normalize = (value) => String(value ?? "").replace(/\r\n?/g, "\n");
  return normalize(currentBody) !== normalize(nextBody)
    || Boolean(nextTitle && currentTitle !== nextTitle);
}
