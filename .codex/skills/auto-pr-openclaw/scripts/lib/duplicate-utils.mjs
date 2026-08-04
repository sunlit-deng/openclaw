import path from "node:path";

const MIN_SPECIFIC_FILE_STEM_LENGTH = 9;

function fileStem(file) {
  return path.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
}

export function isLikelyDuplicate(item, files) {
  if (item.overlappingFiles.length > 0) return true;
  if (item.matchedQueries.some((query) => /^#\d+$/.test(query))) return true;

  const title = item.title.toLowerCase();
  return files.some((file) => {
    const stem = fileStem(file);
    return stem.length >= MIN_SPECIFIC_FILE_STEM_LENGTH && title.includes(stem);
  });
}
