// ---------------------------------------------------------------------------
// Game configuration.
//
// LEADERBOARD_URL points at the score API. Leave it empty and the game keeps a
// leaderboard on this device only — everything still works, the scores just
// aren't shared with anyone.
//
// To make it shared, deploy the worker in ../leaderboard (see its README) and
// paste the URL it prints here, without a trailing slash. For example:
//
//   export const LEADERBOARD_URL = "https://nectar-nova-scores.you.workers.dev"
// ---------------------------------------------------------------------------

export const LEADERBOARD_URL = ""
