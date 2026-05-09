/// <reference types="vite/client" />

declare module '*.wav' {
    const src: string;
    export default src;
}

declare global {
    interface Window {
        electron?: {
            openExternal?: (url: string) => Promise<boolean>;
        };
    }
}

export { };
