// Microfiche East Asian width: one range table shared by pagination geometry
// and glyph normalization so both agree on which characters take two cells.

const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0x2eff],
    [0x2f00, 0x2fdf],
    [0x3000, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe4f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];

/**
 * @param {number} codePoint
 * @returns {boolean} True for East Asian wide/fullwidth ranges.
 */
export function isWideCodePoint(codePoint) {
    return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}
