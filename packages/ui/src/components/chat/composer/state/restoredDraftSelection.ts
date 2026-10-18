export const restoredDraftSelection = (
  source: 'saved' | 'fork',
  options: { isMobile: boolean; caretAtEnd: boolean },
): 'all' | 'end' => (source !== 'fork' && (options.isMobile || options.caretAtEnd) ? 'end' : 'all');
