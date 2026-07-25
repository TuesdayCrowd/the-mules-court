/**
 * WCAG 2.1 relative luminance and contrast ratio (UIX §11).
 *
 * Arithmetic rather than measured, because the accessibility gate runs under
 * jsdom, which has no layout and therefore no computed colours. axe-core's
 * colour-contrast rule is silently skipped there; this file is what covers it.
 */

function channelLuminance(srgb: number): number {
    const c = srgb / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: number): number {
    const r = channelLuminance((hex >> 16) & 0xff);
    const g = channelLuminance((hex >> 8) & 0xff);
    const b = channelLuminance(hex & 0xff);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: number, b: number): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}
