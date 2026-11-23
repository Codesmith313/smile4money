# Provider settlement evidence

The fetchers return normalized game results or typed errors. No error carries
settlement evidence. The worker applies these policies:

| Outcome | Error | Action |
| --- | --- | --- |
| HTTP 429 | `RateLimitError` | Retry (Lichess also makes at most three internal retries respecting Retry-After) |
| Network/timeout, HTTP 408 or 5xx | `ProviderFetchError: unavailable` | Retry through the worker's bounded attempt policy |
| Missing game (404 / exhausted Chess.com archive search) | `GameNotFoundError` | Stop polling |
| Malformed response, unknown/inconsistent result codes or chronology | `ProviderFetchError: invalid_data` | Quarantine; remove polling job and invoke the existing DLQ/operator callback immediately |
| Other HTTP errors, including access denial | `ProviderFetchError: access_denied` | Operator review |

Oracle verification returns 503 for transient provider failures and 422 with an
`operator_review` hint for quarantined evidence. Quarantine diagnostics contain
only a provider name and a fixed reason code, never response bodies, credentials,
player names or unknown result labels.

Chess.com result codes follow its [published API documentation](https://www.chess.com/news/view/published-data-api).
A win must be paired with a documented loss; both players must have draw codes
for a draw. Unknown codes and contradictory pairs require review.

Completed evidence must have positive, finite integer millisecond timestamps,
end >= start, and end <= current time + 60 seconds of clock skew. Wall duration
is limited to 24 hours for live games and a conservative ten years (366 days per
year) for correspondence/daily games. These are review thresholds, not deductions
from time controls: increments, vacations and pauses prevent a reliable duration
calculation from base time alone. Lichess uses createdAt/lastMoveAt (milliseconds).
Chess.com uses start_time/end_time (seconds); live games without start_time must
supply UTCDate and UTCTime PGN tags. Missing chronology requires review.

Each persisted settlement result and oracle decision records the provider that
supplied it (`lichess` or `chessdotcom`). `GET /api/oracle/reviews/:gameId`
returns the provider with each decision. If the provider differs from an
earlier decision for the same game, the append-only ledger records a separate
`provider_changed` entry with both the previous and current provider.

Result submission is permitted only after the provider reports a finished game
and its end time is no later than the verification time. Premature attempts
return HTTP 425 with a timing-violation message; polling treats these as
in-progress and retries later.

Match identifiers start at zero, as in the escrow contract and local store. The
number-based API accepts 0 through Number.MAX_SAFE_INTEGER, inclusive, which is
the exactly representable subset of the contract's u64 identifiers. Larger IDs
require a future string/bigint API rather than rounding a number. Both stores
refuse to allocate beyond this range.
