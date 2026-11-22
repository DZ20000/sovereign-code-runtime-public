export const VISUAL_LANGUAGES = ["en", "zh-CN"] as const;
export const VISUAL_THEMES = ["light", "dark"] as const;
export const VISUAL_VIEWPORTS = [{ width: 1040, height: 680 }, { width: 1360, height: 860 }] as const;

export interface VisualContext {
  readonly language: (typeof VISUAL_LANGUAGES)[number];
  readonly theme: (typeof VISUAL_THEMES)[number];
  readonly width: number;
  readonly height: number;
}

export interface RenderedVisualContext {
  readonly language: string;
  readonly theme: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}

export const VISUAL_MATRIX: readonly VisualContext[] = VISUAL_LANGUAGES.flatMap((language) =>
  VISUAL_THEMES.flatMap((theme) => VISUAL_VIEWPORTS.map((viewport) => ({ language, theme, ...viewport }))),
);

export function visualContextKey(context: VisualContext): string {
  return [context.language, context.theme, context.width + "x" + context.height].join("/");
}

/** A physical screenshot width is not a CSS viewport when Electron applies zoom. */
export function assertVisualContext(expected: VisualContext, actual: RenderedVisualContext): void {
  if (actual.width !== expected.width || actual.height !== expected.height || actual.zoom !== 1
      || actual.language !== expected.language || actual.theme !== expected.theme) {
    throw new Error("Rendered visual context does not match its matrix cell: " + JSON.stringify({ expected, actual }));
  }
}

export function visualScreenshotPath(context: VisualContext, surface: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(surface)) throw new Error("Invalid visual surface name.");
  return visualContextKey(context) + "/" + surface + ".png";
}
