/**
 * Structural replica of a real 121-message chat whose Summarizer had ghosted a
 * 105-message prefix while the tail stayed in the Verbatim Window (ADR-0028).
 *
 * Every structural number is verbatim from the analysed export; every string is
 * synthetic, so no roleplay prose survives. The numbers the fixture exists to
 * pin:
 *
 * - 121 messages: index 0 the opening reply, then strict user/assistant
 *   alternation, so assistant replies sit on the even indices.
 * - Ghosting owns indices 0-104 (105 messages), and every owned message carries
 *   the host hide flag, which is the collision ADR-0028 settles.
 * - 53 Continuity Checkpoints, and eight assistant replies without one: index 0
 *   (the opening reply, never paired), 120 (un-audited, mid-generation), and the
 *   six whose audit left no payload: 10, 34, 46, 54, 60, 62.
 * - A Turn Count that sawtooths against Ghosting: 2 climbs to 17, then resets to
 *   8 when a summarization cycle hides the replies the previous counts covered.
 *   The old host-flag predicate read the collapsed tail as the whole chat, so a
 *   Turn Count of 8 covered 61 Exchanges.
 * - The GM-note book saturated at its old 10-per-kind / 20-total caps and stayed
 *   there for the last 22 Checkpoints, R1/T9/S10.
 */

/** Assistant chat indices owned by Ghosting, inclusive. */
export const GHOSTED_RANGE = Object.freeze([0, 104]);

/** Chat size and role split, verbatim from the export. */
export const CHAT_SHAPE = Object.freeze({
    messages: 121,
    userMessages: 60,
    assistantMessages: 61,
    ghostedMessages: 105,
});

/** Every assistant reply the export carried no Continuity Checkpoint for. */
export const CHECKPOINT_GAPS = Object.freeze([0, 10, 34, 46, 54, 60, 62, 120]);

/**
 * The Continuity Checkpoint ledger: `[chatIndex, turn_count, [R], [T], [S]]`
 * per checkpoint, in write order. The `turn_count` column is the sawtooth.
 */
export const CHECKPOINT_LEDGER = Object.freeze([
    [2, 2, 1, 1, 2],
    [4, 3, 1, 2, 4],
    [6, 4, 1, 3, 6],
    [8, 5, 1, 3, 7],
    [12, 7, 1, 3, 9],
    [14, 8, 1, 4, 10],
    [16, 9, 1, 4, 10],
    [18, 10, 1, 4, 10],
    [20, 11, 1, 4, 10],
    [22, 12, 1, 5, 10],
    [24, 13, 1, 5, 10],
    [26, 14, 1, 7, 10],
    [28, 15, 1, 7, 10],
    [30, 16, 1, 8, 10],
    [32, 17, 1, 9, 10],
    [36, 8, 1, 9, 10],
    [38, 9, 1, 9, 10],
    [40, 10, 1, 9, 10],
    [42, 11, 1, 9, 10],
    [44, 12, 1, 9, 10],
    [48, 14, 1, 9, 10],
    [50, 15, 1, 9, 10],
    [52, 7, 1, 9, 10],
    [56, 9, 1, 9, 10],
    [58, 10, 1, 9, 10],
    [64, 13, 1, 9, 10],
    [66, 14, 1, 9, 10],
    [68, 15, 1, 9, 10],
    [70, 7, 1, 9, 10],
    [72, 8, 1, 9, 10],
    [74, 9, 1, 9, 10],
    [76, 10, 1, 9, 10],
    [78, 11, 1, 9, 10],
    [80, 12, 1, 9, 10],
    [82, 13, 1, 9, 10],
    [84, 14, 1, 9, 10],
    [86, 15, 1, 9, 10],
    [88, 8, 1, 9, 10],
    [90, 9, 1, 9, 10],
    [92, 10, 1, 9, 10],
    [94, 11, 1, 9, 10],
    [96, 12, 1, 9, 10],
    [98, 13, 1, 9, 10],
    [100, 14, 1, 9, 10],
    [102, 6, 1, 9, 10],
    [104, 7, 1, 9, 10],
    [106, 8, 1, 9, 10],
    [108, 9, 1, 9, 10],
    [110, 10, 1, 9, 10],
    [112, 11, 1, 9, 10],
    [114, 12, 1, 9, 10],
    [116, 13, 1, 9, 10],
    [118, 14, 1, 9, 10],
]);

/** Character-card name for the tracked NPC, spelled as the card spells it. */
export const NPC_NAME = 'Ayla';

/** The pair key every bond line renders under. */
export const PAIR_KEY = `${NPC_NAME}↔User`;

/**
 * Synthetic Continuity State carrying only the ledger's structural facts.
 * Body prose is deliberately generic; the counts and the Turn Count are not.
 * @param {[number, number, number, number, number]} row - Ledger row.
 * @returns {object} A checkpoint payload.
 */
function buildState([, turnCount, reminders, threads, secrets]) {
    return {
        turn_count: turnCount,
        bonds: { [PAIR_KEY]: { bond: turnCount % 7, sparks: turnCount % 5, grudge: 0 } },
        agendas: {
            [NPC_NAME]: {
                task: `Undergo agenda ${turnCount}`,
                step: { current: 1 + (turnCount % 3), max: 3 },
                status: `Off-screen at location ${turnCount}`,
            },
        },
        gm_notes: [
            ...Array.from({ length: reminders }, (_, i) => `[R] Standing rule ${i + 1}`),
            ...Array.from({ length: threads }, (_, i) => `[T] Open thread ${i + 1}; COMPLETED`),
            ...Array.from(
                { length: secrets },
                (_, i) => `[S] ${NPC_NAME} knows fact ${i + 1} (User unaware)`,
            ),
        ],
        physics: {
            location: `Place ${turnCount}`,
            environment: `Conditions ${turnCount}`,
            posture_and_position: `Posture ${turnCount}`,
            contact_points: '',
            clothing_state: `Clothing ${turnCount}`,
        },
    };
}

/**
 * A checkpoint payload as an older build stored it: the retired agenda fields
 * still sit in the JSON, and the renderer must ignore them (ADR-0029).
 * @param {[number, number, number, number, number]} row - Ledger row.
 * @returns {object} A checkpoint payload carrying the retired fields.
 */
function buildLegacyState(row) {
    const state = buildState(row);
    return {
        ...state,
        agendas: {
            [NPC_NAME]: {
                ...state.agendas[NPC_NAME],
                body_state: 'retired field',
                fibs: 'retired field',
                aware: 'retired field',
            },
        },
    };
}

/**
 * Build the chat: strict alternation, a ghosted prefix, and the ledger's
 * checkpoints. Odd indices are user turns; every owned message carries
 * `is_system`, which is what the host hide command writes.
 * @returns {object[]} The chat array.
 */
export function buildGhostedChat() {
    const [firstGhosted, lastGhosted] = GHOSTED_RANGE;
    const chat = [];
    for (let index = 0; index < CHAT_SHAPE.messages; index++) {
        const isUser = index % 2 === 1;
        const owned = index >= firstGhosted && index <= lastGhosted;
        chat.push({
            name: isUser ? 'User' : NPC_NAME,
            is_user: isUser,
            ...(owned ? { is_system: true } : {}),
            mes: isUser ? `User turn ${index}` : `Reply ${index}`,
            sc_id: `sc-${index}`,
            extra: {},
        });
    }
    for (const row of CHECKPOINT_LEDGER) {
        chat[row[0]].extra.summaryception_continuity =
            row[0] === CHECKPOINT_LEDGER[0][0] ? buildLegacyState(row) : buildState(row);
    }
    return chat;
}
