// Snapshot helper — queries the Snapshot GraphQL Hub API.
//
// Two responsibilities:
//   1. getNewProposals(space, since)  -> proposals in a space created after a timestamp
//   2. getVote(proposalId, voter)     -> a single address's vote on a proposal (or null)
//
// Uses the public Snapshot hub GraphQL endpoint. No API key required, but the hub
// is rate limited, so callers should avoid hammering it.

const HUB_URL = "https://hub.snapshot.org/graphql";

// Node 18+ exposes a global fetch. Fall back to node-fetch if it's ever missing.
const fetchFn = (typeof fetch === "function")
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// Low-level GraphQL POST against the hub. Throws on network errors or GraphQL errors
// so callers can decide how to handle failures.
async function query(gql, variables = {}) {
    const res = await fetchFn(HUB_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: gql, variables })
    });

    if (!res.ok) {
        throw new Error(`Snapshot hub HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length) {
        throw new Error(`Snapshot GraphQL error: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
}

// Fetch proposals for a space, newest first. Pages through results in blocks of
// `pageSize` and stops early once proposals older than `since` are reached (since
// results are ordered by creation time descending, everything after is older too).
//
//   space    - Snapshot space id, e.g. "curve.eth"
//   since    - unix timestamp (seconds); only proposals created strictly after this
//              are returned. Pass 0 to get everything (up to `max`).
//   options  - { state, pageSize, max }
//                state    filter by "active" | "closed" | "pending" | "all" (default "all")
//                pageSize proposals per request (default 20, hub max 100)
//                max      hard cap on total proposals returned (default 100)
//
// Returns an array of proposals ordered newest-first.
async function getNewProposals(space, since = 0, options = {}) {
    const state = options.state || "all";
    const pageSize = Math.min(Number(options.pageSize) || 20, 100);
    const max = Number(options.max) || 100;

    const gql = `
        query Proposals($space: String!, $first: Int!, $skip: Int!, $state: String!, $since: Int!) {
            proposals(
                first: $first,
                skip: $skip,
                where: { space: $space, state: $state, created_gt: $since },
                orderBy: "created",
                orderDirection: desc
            ) {
                id
                title
                body
                choices
                start
                end
                snapshot
                state
                created
                author
                scores
                scores_total
                scores_state
            }
        }
    `;

    const collected = [];
    let skip = 0;

    while (collected.length < max) {
        const first = Math.min(pageSize, max - collected.length);
        // created_gt is applied server-side, so every returned proposal is already
        // newer than `since` — no client-side timestamp filtering needed.
        const data = await query(gql, { space, first, skip, state, since });
        const page = (data && data.proposals) || [];
        if (page.length === 0) break;

        collected.push(...page);

        if (page.length < first) break;
        skip += page.length;
    }

    return collected;
}

// Look up a single address's vote on a proposal.
//
//   proposalId - the Snapshot proposal id (the long 0x... hash)
//   voter      - the voter address
//
// Returns the vote object ({ id, voter, created, choice, vp, reason }) or null if
// the address did not vote on that proposal. `choice` shape depends on the voting
// type (single number, array, or object for weighted/ranked voting).
async function getVote(proposalId, voter) {
    const gql = `
        query Vote($proposal: String!, $voter: String!) {
            votes(
                first: 1,
                where: { proposal: $proposal, voter: $voter }
            ) {
                id
                voter
                created
                choice
                vp
                reason
            }
        }
    `;

    const data = await query(gql, { proposal: proposalId, voter });
    const votes = (data && data.votes) || [];
    return votes.length ? votes[0] : null;
}

// Convenience boolean wrapper around getVote.
async function hasVoted(proposalId, voter) {
    return (await getVote(proposalId, voter)) !== null;
}

module.exports = {
    query,
    getNewProposals,
    getVote,
    hasVoted,
    HUB_URL
};
