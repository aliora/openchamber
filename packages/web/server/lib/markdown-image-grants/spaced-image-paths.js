const SPACED_IMAGE_PATH = /!\[([^\]\n]*)\]\(([^()<>"'\n]*\s[^()<>"'\n]*\.(?:png|jpe?g|gif|webp))\)/gi;

/** `![alt](dir/my file.png)` is not an image in CommonMark; `<...>` makes the spaced path one destination. */
export const wrapSpacedImagePath = (line) => line.replace(SPACED_IMAGE_PATH, (_match, alt, source) => `![${alt}](<${source.trim()}>)`);
