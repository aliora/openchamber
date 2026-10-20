import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLVideoElement: browser.HTMLVideoElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { AttachedFilesList } = await import('./FileAttachment');
const { useInputStore } = await import('@/sync/input-store');
const { readAttachmentUpload, startAttachmentUpload } = await import('@/sync/attachment-uploads');
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const video: AttachedFile = {
  id: 'video-1',
  file: new File([new Uint8Array(3 * 1024 * 1024)], 'clip.mov', { type: 'video/quicktime' }),
  dataUrl: '',
  mimeType: 'video/quicktime',
  filename: 'clip.mov',
  size: 3 * 1024 * 1024,
  source: 'local',
};

const neverAnsweredChunk = (input: string, init: RuntimeFetchOptions): Promise<Response> => {
  if (input === '/api/attachments') {
    return Promise.resolve(new Response(JSON.stringify({ id: 'up-1', uri: 'openchamber-attachment:up-1' }), { status: 201 }));
  }
  if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
  return new Promise<Response>((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
};

const render = async () => {
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <AttachedFilesList />
        </TooltipProvider>
      </I18nProvider>,
    );
  });
};

afterAll(async () => {
  await act(async () => root.unmount());
  browser.close();
});

describe('composer video attachment', () => {
  test('shows a video as a preview with its size and upload progress, and removing it cancels the upload', async () => {
    useInputStore.setState({ attachedFiles: [video] });
    startAttachmentUpload(video, neverAnsweredChunk);
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const tile = container.querySelector('[data-attachment-kind="video"]');
    expect(tile).not.toBeNull();
    expect(tile?.querySelector('video')).not.toBeNull();
    expect(tile?.textContent).toContain('3.0 MB');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');

    const videoElement = tile?.querySelector('video');
    expect(videoElement?.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(videoElement?.hasAttribute('disableremoteplayback')).toBe(true);

    const buttons = tile?.querySelectorAll('button') ?? [];
    expect(buttons).toHaveLength(1);
    const remove = buttons[0];
    expect(remove.getAttribute('style')).toBeNull();
    expect(remove.querySelectorAll('svg')).toHaveLength(1);
    await act(async () => {
      remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useInputStore.getState().attachedFiles).toHaveLength(0);
    expect(readAttachmentUpload(video.id)).toBeUndefined();
  });
});
