/**
 * Wire observation for the specs: every frame a page's own sockets carried, in both directions, and
 * the close codes the page received.
 *
 * Test-side observation only — nothing here is added to the product. Frames are read back through
 * the protocol's own types (the client union is validated by its canonical schema), so the capture is
 * the literal wire and a leak or a silent reconnect cannot hide behind the rendering layer.
 */
import type { Page } from '@playwright/test';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { clientMessageSchema } from '../../shared/validation';

declare global {
  interface Window {
    /** Installed by {@link captureCloseCodes} before the page's first script runs. */
    __reportSocketClose: (code: number) => void;
  }
}

export interface SocketCapture {
  frames: { at: number; direction: 'sent' | 'received'; payload: string }[];
}

/**
 * Records WebSocket close codes for the page's own sockets. Must be installed before the page
 * navigates (the single-page app loads once).
 */
export async function captureCloseCodes(page: Page): Promise<() => Promise<number[]>> {
  const codes: number[] = [];
  await page.exposeFunction('__reportSocketClose', (code: number) => {
    codes.push(code);
  });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    class Tracked extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        this.addEventListener('close', (event) => window.__reportSocketClose(event.code));
      }
    }
    window.WebSocket = Tracked;
  });
  return async () => codes.slice();
}

/**
 * Records every WebSocket frame on the page (both directions). Attach this BEFORE the page
 * navigates or connects: only sockets created after the listener is attached are captured.
 */
export function captureSockets(page: Page): SocketCapture {
  const capture: SocketCapture = { frames: [] };
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) =>
      capture.frames.push({ at: Date.now(), direction: 'sent', payload: String(event.payload) }),
    );
    socket.on('framereceived', (event) =>
      capture.frames.push({
        at: Date.now(),
        direction: 'received',
        payload: String(event.payload),
      }),
    );
  });
  return capture;
}

function frames(capture: SocketCapture, direction: 'sent' | 'received') {
  return capture.frames.filter((frame) => frame.direction === direction);
}

/** Only what the server sent to this page: the authoritative privacy boundary. */
export function receivedText(capture: SocketCapture): string {
  return frames(capture, 'received')
    .map((frame) => frame.payload)
    .join('\n');
}

/** A parsed frame value, or `null` when the payload was not JSON at all. */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** The protocol's three server messages, recognised by the union's own discriminant. */
function serverMessage(payload: string): ServerMessage | null {
  const value = parseJson(payload);
  if (value === null || typeof value !== 'object' || !('type' in value)) return null;
  const { type } = value;
  if (type !== 'state' && type !== 'error' && type !== 'pong') return null;
  // The discriminant is the union's own key; the rest of the frame is the app's output on its wire.
  return value as ServerMessage;
}

export interface ReceivedFrame {
  at: number;
  payload: string;
  /** The server message this frame carried, or `null` when it was not one. */
  message: ServerMessage | null;
}

/** Parsed server frames, so phase and combat state can be judged from the payload itself. */
export function receivedFrames(capture: SocketCapture): ReceivedFrame[] {
  return frames(capture, 'received').map((frame) => ({
    at: frame.at,
    payload: frame.payload,
    message: serverMessage(frame.payload),
  }));
}

/** Parsed client frames, so a spec can assert on the exact input contract it sent. */
export function sentMessages(capture: SocketCapture): ClientMessage[] {
  return frames(capture, 'sent').flatMap((frame) => {
    const message = clientMessageSchema.safeParse(parseJson(frame.payload));
    return message.success ? [message.data] : [];
  });
}

/** Sends raw room frames over a fresh socket (used for replay/cut-off input checks). */
export async function sendRawMessages(
  page: Page,
  roomId: string,
  messages: ClientMessage[],
): Promise<void> {
  await page.evaluate(
    ({ roomId: id, messages: payload }) =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
        socket.onopen = () => {
          for (const message of payload) socket.send(JSON.stringify(message));
          setTimeout(() => {
            socket.close();
            resolve();
          }, 1200);
        };
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
        setTimeout(() => resolve(), 8000);
      }),
    { roomId, messages },
  );
}
