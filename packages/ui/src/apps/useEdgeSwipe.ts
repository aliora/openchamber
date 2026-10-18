import React from 'react';

/**
 * Native-feeling edge swipes on the mobile shell: start a horizontal swipe from
 * the very left/right screen edge and drag toward the centre.
 *
 * On the chat that opens a drawer (left edge → sessions, right edge →
 * workspace); on an open drawer the mirrored swipe closes it (sessions drawer
 * closes from the right edge, workspace drawer from the left edge).
 *
 * Touch listeners are passive to preserve native scrolling and text selection.
 * A selection cancels the pending swipe, even if it clears before touchend.
 * A swipe that starts on content still able to scroll the way the finger moves
 * (a wide table, a code block) belongs to that content, not the drawer. Once
 * that content sits at the end of that direction the drawer can still be
 * reached, but only by a long, clearly horizontal swipe, so a scroll that has
 * simply run out of room is not mistaken for intent.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
// Android reserves the physical screen edge for system navigation. Accept a
// wider start area so both OpenChamber drawers can be invoked beyond the
// system Back gesture region without changing the browser/iOS gesture.
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64; // px of horizontal travel required to commit
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)
// A gesture that starts on content already at the end of a direction may still
// reach the drawer, but only as a deliberate swipe: longer and flatter than an
// ordinary one, so a scroll that ran out of room is not read as intent.
const STRICT_MIN_DISTANCE = 140;
const STRICT_MAX_OFF_AXIS_RATIO = 0.4;
const DRAG_SLOP = 10;
const DRAG_COMMIT_FRACTION = 0.4;
const FLING_VELOCITY = 0.3;
const VELOCITY_IDLE_MS = 80;
const VELOCITY_WINDOW_MS = 100;
const WIDE_START_FRACTION = 1 / 3;

export interface DrawerDragControl {
  follow: (distance: number) => void;
  settle: (open: boolean) => void;
}

export interface EdgeDragRelease {
  distance: number;
  velocity: number;
  width: number;
}

export const resolveEdgeDragRelease = ({ distance, velocity, width }: EdgeDragRelease): boolean => {
  if (distance <= 0) return false;
  if (velocity >= FLING_VELOCITY) return true;
  if (velocity <= -FLING_VELOCITY) return false;
  return distance >= width * DRAG_COMMIT_FRACTION;
};

interface EdgeSwipeOptions {
  /** Swipe that started at the left edge and travelled right. */
  onLeftEdgeSwipe?: () => void;
  /** Swipe that started at the right edge and travelled left. */
  onRightEdgeSwipe?: () => void;
  onLeftEdgeDrag?: DrawerDragControl;
  onRightEdgeDrag?: DrawerDragControl;
  /** This side also accepts a swipe starting anywhere in its outer third,
      as long as nothing under the finger scrolls horizontally. */
  wideStartEdge?: 'left' | 'right';
  /** Defaults to on. Flipping it re-attaches the listeners, which is what a
      drawer needs: its element only exists (or only matters) while open. */
  enabled?: boolean;
}

// Who owns a horizontal gesture that started here: the content under the finger
// while it can still scroll that way ('content'), the same content once it sits
// at the end of that direction ('content-end'), or the drawer when there is no
// horizontally scrollable content at all ('drawer'). A swipe from the left edge
// reveals content on the left, one from the right edge content on the right.
// RTL scrollers run scrollLeft from -range up to 0.
type GestureOwner = 'drawer' | 'content' | 'content-end';

const resolveGestureOwner = (target: EventTarget | null, container: HTMLElement, fromLeftEdge: boolean): GestureOwner => {
  const view = container.ownerDocument.defaultView;
  if (!view) return 'drawer';
  let contentEnd = false;
  for (let node = target instanceof view.Element ? target : null; node && node !== container; node = node.parentElement) {
    const range = node.scrollWidth - node.clientWidth;
    if (range <= 1) continue;
    const style = view.getComputedStyle(node);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    const min = style.direction === 'rtl' ? -range : 0;
    const max = min + range;
    if (fromLeftEdge ? node.scrollLeft > min + 1 : node.scrollLeft < max - 1) return 'content';
    contentEnd = true;
  }
  return contentEnd ? 'content-end' : 'drawer';
};

export const useEdgeSwipe = (
  ref: React.RefObject<HTMLElement | null>,
  options: EdgeSwipeOptions,
): void => {
  // Keep callbacks in a ref so changing identities don't re-attach the listeners.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;
  const interactive = Boolean(options.onLeftEdgeDrag || options.onRightEdgeDrag);

  React.useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    // SAFETY: Native Capacitor shells inject this bridge; both accesses are optional for web builds.
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;
    const ownerDocument = element.ownerDocument;

    let tracking = false;
    let fromLeftEdge = false;
    let owner: GestureOwner = 'drawer';
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let frame = 0;
    let pendingDistance = 0;
    let samples: Array<{ x: number; time: number }> = [];

    const view = ownerDocument.defaultView ?? window;
    const dragControl = () => (fromLeftEdge ? optionsRef.current.onLeftEdgeDrag : optionsRef.current.onRightEdgeDrag);
    const stopDrag = (open: boolean) => {
      if (!dragging) return;
      dragging = false;
      if (frame) view.cancelAnimationFrame(frame);
      frame = 0;
      dragControl()?.settle(open);
    };

    const hasSelection = () => ownerDocument.getSelection()?.isCollapsed === false;
    const cancelSwipe = () => {
      stopDrag(false);
      tracking = false;
    };
    const onSelectionChange = () => {
      if (tracking && hasSelection()) cancelSwipe();
    };

    const onTouchStart = (event: TouchEvent) => {
      stopDrag(false);
      if (event.touches.length !== 1 || hasSelection()) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      const wideSide = optionsRef.current.wideStartEdge;
      const inWideZone = wideSide === 'left'
        ? touch.clientX <= width * WIDE_START_FRACTION
        : wideSide === 'right' && touch.clientX >= width * (1 - WIDE_START_FRACTION);
      fromLeftEdge = nearLeft || (!nearRight && inWideZone && wideSide === 'left');
      if (nearLeft || nearRight) {
        owner = resolveGestureOwner(event.target, element, fromLeftEdge);
        tracking = owner !== 'content';
      } else {
        owner = inWideZone ? resolveGestureOwner(event.target, element, fromLeftEdge) : 'content';
        tracking = owner === 'drawer';
      }
      startX = touch.clientX;
      startY = touch.clientY;
      samples = [{ x: startX, time: event.timeStamp }];
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || owner !== 'drawer') return;
      const control = dragControl();
      const touch = event.touches[0];
      if (!control || !touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const distance = fromLeftEdge ? dx : -dx;
      if (!dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return;
        if (distance <= 0 || Math.abs(dy) > Math.abs(dx)) {
          tracking = false;
          return;
        }
        dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      samples.push({ x: touch.clientX, time: event.timeStamp });
      while (samples.length > 2 && event.timeStamp - samples[0].time > VELOCITY_WINDOW_MS) samples.shift();
      pendingDistance = Math.max(0, distance);
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        if (dragging) control.follow(pendingDistance);
      });
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (dragging) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const endX = touch?.clientX ?? last.x;
        const idle = event.timeStamp - last.time > VELOCITY_IDLE_MS;
        const rawVelocity = idle ? 0 : (last.x - first.x) / Math.max(1, last.time - first.time);
        const commit = !hasSelection() && resolveEdgeDragRelease({
          distance: fromLeftEdge ? endX - startX : startX - endX,
          velocity: fromLeftEdge ? rawVelocity : -rawVelocity,
          width: element.clientWidth,
        });
        stopDrag(commit);
        if (!commit) return;
        if (fromLeftEdge) optionsRef.current.onLeftEdgeSwipe?.();
        else optionsRef.current.onRightEdgeSwipe?.();
        return;
      }
      if (hasSelection()) return;
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // Content sitting at its end hands the gesture to the drawer only for a
      // long, clearly horizontal swipe.
      const minDistance = owner === 'content-end' ? STRICT_MIN_DISTANCE : MIN_DISTANCE;
      const maxOffAxisRatio = owner === 'content-end' ? STRICT_MAX_OFF_AXIS_RATIO : MAX_OFF_AXIS_RATIO;
      if (Math.abs(dx) < minDistance) return;
      if (Math.abs(dy) > Math.abs(dx) * maxOffAxisRatio) return;
      // Must travel toward the centre: left edge → rightward, right edge → leftward.
      if (fromLeftEdge && dx <= 0) return;
      if (!fromLeftEdge && dx >= 0) return;

      if (fromLeftEdge) optionsRef.current.onLeftEdgeSwipe?.();
      else optionsRef.current.onRightEdgeSwipe?.();
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    if (interactive) element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', cancelSwipe, { passive: true });
    element.addEventListener('selectstart', cancelSwipe);
    ownerDocument.addEventListener('selectionchange', onSelectionChange);
    return () => {
      stopDrag(false);
      element.removeEventListener('touchstart', onTouchStart, { capture: true });
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', cancelSwipe);
      element.removeEventListener('selectstart', cancelSwipe);
      ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [enabled, interactive, ref]);
};
