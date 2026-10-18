export type ClipboardCopyResult =
  | { ok: true; method: 'clipboard' | 'execCommand' }
  | { ok: false; error: string };

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  let clipboardError: string | null = null;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
    }
  }

  if (typeof document !== 'undefined' && document.body) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (copied) {
      return { ok: true, method: 'execCommand' };
    }
  }

  return {
    ok: false,
    error: clipboardError ?? 'Clipboard access denied in current context',
  };
}

const isNativeShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
};

const readNativeClipboardText = async (): Promise<string> => {
  const { Clipboard } = await import('@capacitor/clipboard');
  const { value, type } = await Clipboard.read();
  return type.startsWith('text/') ? value : '';
};

export async function readClipboardText(): Promise<string> {
  if (isNativeShell()) {
    const nativeText = await readNativeClipboardText().catch(() => null);
    if (nativeText !== null) return nativeText;
  }
  return navigator.clipboard.readText();
}

// `plainText` replaces the Markdown source in `text/plain` for users who copy
// messages as plain text; the Markdown flavor is then left out entirely.
export async function copyMarkdownToClipboard(
  markdown: string,
  html: string,
  options: { plainText?: string } = {},
): Promise<ClipboardCopyResult> {
  const text = options.plainText ?? markdown;
  if (
    typeof navigator !== 'undefined'
    && navigator.clipboard?.write
    && typeof ClipboardItem !== 'undefined'
  ) {
    try {
      const payload: Record<string, Blob> = {
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      };
      if (options.plainText === undefined && typeof ClipboardItem.supports === 'function' && ClipboardItem.supports('text/markdown')) {
        payload['text/markdown'] = new Blob([markdown], { type: 'text/markdown' });
      }
      await navigator.clipboard.write([new ClipboardItem(payload)]);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fall back to text only when rich clipboard writes are unavailable.
    }
  }

  return copyTextToClipboard(text);
}
