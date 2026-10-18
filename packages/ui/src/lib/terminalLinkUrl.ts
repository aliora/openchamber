import { toPlainTerminalText } from './chatCommandRun';
import { isLoopbackHttpUrl } from './url';

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[).,;:!?\]}]+$/;

export const findLastExternalTerminalUrl = (raw: string): string | null => {
  const matches = toPlainTerminalText(raw).match(URL_PATTERN) ?? [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const url = matches[index]!.replace(TRAILING_PUNCTUATION, '');
    if (URL.canParse(url) && !isLoopbackHttpUrl(url)) return url;
  }
  return null;
};
