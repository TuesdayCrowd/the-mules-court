/**
 * The canvas half of the single palette (UIX §2.3). `src/client/styles/tokens.css`
 * is authoritative; `tokens.test.ts` fails the build if these two ever disagree.
 * Numbers, not strings, because every Phaser tint and fill takes an integer.
 */
export const TOKENS = {
    colorBg: 0x000000,
    colorNebulaRed: 0xef4444,
    colorNebulaPurple: 0xa855f7,

    colorSeatCurrent: 0xef4444,
    colorSeatOther: 0x6b7280,
    colorSeatProtected: 0x22d3ee,
    colorSeatEliminated: 0x9ca3af,
    colorSeatDisconnected: 0x6b7280,

    colorStateYourTurn: 0xc084fc,
    colorStateWaiting: 0x9ca3af,
    colorStateRoundOver: 0x4ade80,
    colorStatePaused: 0xfbbf24,
    colorStateMatchOver: 0xfbbf24,

    colorDeckFull: 0x9333ea,
    colorDeckLow: 0xb45309,
    colorDeckEmpty: 0x991b1b
} as const;
