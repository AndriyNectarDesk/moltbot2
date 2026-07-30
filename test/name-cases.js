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
]
