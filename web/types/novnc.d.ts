// The part of noVNC's RFB client the desktop view uses. @types/novnc__novnc describes the old `lib/rfb` path, not
// the `core/rfb.js` that @novnc/novnc 1.7 exports.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: Element,
      urlOrChannel: string | WebSocket,
      options?: { readonly wsProtocols?: string[] }
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
  }
}
