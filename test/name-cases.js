// What a typed name becomes, as a table.
//
// This exists because the rule is implemented twice: `leaderboard/players.js`
// decides for real, and `site/shared/leaderboard.js` carries a copy so the
// signup form can complain while you type. Both test files import this table and
// run it against their own copy, so the day the two drift, one of them fails
// with the exact case that differs — which is the only way a duplicated rule is
// safe to keep.
//
// Each row is [input, expected id, why anyone should care].

export const NAME_CASES = [
	["Zoe", "zoe", "lowercased, because the board is keyed on this"],
	["ZOE", "zoe", "so it is the same player as the last one"],
	["  zoe  ", "zoe", "trimmed"],
	["zoe   b", "zoe b", "inner runs of space collapsed"],
	["<script>zoe</script>", "scriptzoescrip", "markup characters dropped, then capped"],
	["z", "", "too short to tell two kids apart"],
	["", "", "nothing is not a name"],
	["   ", "", "nor is whitespace"],
	["1234", "", "an all-digit name reads as a score in the tables"],
	["zoe123", "zoe123", "digits are fine alongside a letter"],
	["a".repeat(40), "a".repeat(14), "capped, not rejected — long names still play"],
	["зоя", "зоя", "not everyone in this family types in ASCII"],
	["zoe!!!", "zoe", "punctuation that isn't . _ or - is dropped"],
	["mo-mo_1.2", "mo-mo_1.2", "the punctuation that is allowed survives"],
	// U+043E, the Cyrillic one. Renders identically to the Latin o and would put a
	// second DANYLO on a board a cash prize is paid against.
	["danylо", "", "a name mixing scripts is not a name, it is a costume"],
	["зоя b", "", "…even when the mixture is only a trailing Latin initial"],
	// Deseret, which is astral: every letter is two UTF-16 units. A .slice() here
	// would cut one in half and leave a lone surrogate, and two different names
	// could then end up as the same bytes in a KV key — one credential record
	// serving two board identities. Also lowercased, which astral letters can be.
	["\u{10400}".repeat(20), "\u{10428}".repeat(14), "truncation counts characters, not UTF-16 units"],
]

/**
 * The other rules both copies implement, same discipline as the names.
 *
 * These are duplicated between `leaderboard/players.js` and
 * `site/shared/leaderboard.js` too, and were the part of the duplication that
 * nothing checked.
 */
export const PIN_CASES = [
	["1111", true, "four digits is the floor"],
	["12345678", true, "eight is the ceiling"],
	["123", false, "three is too few to be worth typing"],
	["123456789", false, "nine is past what the input accepts"],
	["12a4", false, "letters are not on every kid's keypad"],
	["", false, "nothing is not a PIN"],
	[null, false, "nor is nothing at all"],
]

/** Names the arcade keeps for itself. `guest` is what the UI calls local-only play. */
export const RESERVED_NAMES = ["guest", "anon", "admin", "player", "nobody", "you"]

export const NAME_LIMITS = { min: 2, max: 14 }
