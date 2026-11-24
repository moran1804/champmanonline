// Minimal types for the parts of noVNC's RFB client we use (the package ships no TypeScript types).
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { password?: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void;
    disconnect(): void;
  }
}
