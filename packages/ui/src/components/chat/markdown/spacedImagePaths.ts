const SPACED_IMAGE_PATH = /!\[([^\]\n]*)\]\(([^()<>"'\n]*\s[^()<>"'\n]*\.(?:png|jpe?g|gif|webp))\)/gi;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

const wrapSpacedImagePath = (line: string): string => (
  line.replace(SPACED_IMAGE_PATH, (_match, alt: string, source: string) => `![${alt}](<${source.trim()}>)`)
);

/** `![alt](dir/my file.png)` is not an image in CommonMark; `<...>` makes the spaced path one destination. */
export const wrapSpacedImagePaths = (markdown: string): string => {
  if (!markdown.includes('](')) return markdown;
  let fence: { char: string; size: number } | null = null;
  return markdown.split('\n').map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0] ?? '', size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size) fence = null;
      return line;
    }
    return fence ? line : wrapSpacedImagePath(line);
  }).join('\n');
};
