/**
 * Ambient module declaration for `pixelmatch` 6.x.
 * The package ships without `.d.ts` files and there is no official
 * `@types/pixelmatch` for v6. This declaration covers the call
 * signature we actually use; keep it minimal.
 */
declare module "pixelmatch" {
  interface PixelmatchOptions {
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number] | null;
    diffMask?: boolean;
  }
  function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    output: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
  export default pixelmatch;
}
