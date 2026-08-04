import { DateTime, Duration, Effect, Option } from 'effect';
import { BAKED_TOOLKIT_SLUGS } from 'src/generated/toolkit-slugs';
import { ComposioToolkitsRepository } from 'src/services/composio-clients';
import {
  readKnownToolkitSlugs,
  writeKnownToolkitSlugs,
  type KnownToolkitSlugs,
} from 'src/services/known-toolkit-slugs';
import { isMetaToolSlug } from 'src/utils/meta-tool-slugs';
import {
  guessToolkitFromToolSlug,
  longestPrefix,
  matchToolkitFromToolSlug,
} from 'src/utils/toolkit-from-tool-slug';

/**
 * How long learned slugs are trusted before a background refresh is started.
 * Only relevant for toolkits released after the last refresh: a slug already
 * known is never wrong, so this bounds how long a *new* toolkit can be
 * mistaken for a shorter one that shares its prefix (a hypothetical
 * `google_analytics_v2` resolving as `google_analytics`).
 */
const REFRESH_AFTER = Duration.days(7);

const learnedSlugs = (learned: Option.Option<KnownToolkitSlugs>): ReadonlyArray<string> =>
  Option.match(learned, {
    onNone: () => [],
    onSome: known => known.slugs,
  });

/**
 * Re-reads the catalog and records it, in the background. Failures are
 * swallowed: a refresh that does not happen costs a fetch later, nothing more.
 */
const refreshKnownToolkitSlugs = Effect.gen(function* () {
  const repository = yield* ComposioToolkitsRepository;
  const toolkits = yield* repository.getToolkits();
  yield* writeKnownToolkitSlugs([...BAKED_TOOLKIT_SLUGS, ...toolkits.map(t => t.slug)]);
}).pipe(Effect.ignore);

/**
 * Starts a refresh when the learned slugs are missing or older than
 * {@link REFRESH_AFTER}. A `refreshedAt` in the future (a clock that jumped)
 * counts as fresh — the point is to bound staleness, not to police clocks.
 *
 * Deliberately not gated to one refresh per process: the catalog fetch behind
 * it is memoized by the cached repository layer, so repeat calls in the same
 * run cost one small file write each.
 */
const refreshInBackgroundIfStale = (learned: Option.Option<KnownToolkitSlugs>) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const isFresh = Option.match(learned, {
      onNone: () => false,
      onSome: known =>
        Duration.lessThan(
          Duration.millis(DateTime.distance(known.refreshedAt, now)),
          REFRESH_AFTER
        ),
    });

    if (isFresh) return;

    yield* Effect.forkDaemon(refreshKnownToolkitSlugs);
  });

/**
 * Resolves the toolkit slug for a tool or trigger slug.
 *
 * No string split can find where the toolkit name ends —
 * `GOOGLE_ANALYTICS_RUN_REPORT` belongs to `google_analytics`, not `google` —
 * so this matches the longest known toolkit slug prefix. "Known" is the
 * catalog baked in at build time plus whatever this machine has learned since,
 * both of which are local: the common case costs one small file read and no
 * network at all.
 *
 * Only a slug that matches nothing known falls through to the catalog, which
 * is what a toolkit released after this binary looks like. Everything else
 * degrades rather than fails: an unreachable catalog still yields the
 * first-underscore guess.
 */
export const toolkitFromToolSlug = (
  toolSlug: string
): Effect.Effect<string | undefined, never, ComposioToolkitsRepository> =>
  Effect.gen(function* () {
    // Meta tools belong to the session rather than to a toolkit, and their
    // slugs shadow real ones — `COMPOSIO_SEARCH_TOOLS` prefix-matches the
    // `composio_search` toolkit, which would send users off to link an app
    // they do not need.
    if (isMetaToolSlug(toolSlug)) {
      return undefined;
    }

    const learned = yield* readKnownToolkitSlugs;
    const knownSlugs = [...BAKED_TOOLKIT_SLUGS, ...learnedSlugs(learned)];

    yield* refreshInBackgroundIfStale(learned);

    const match = longestPrefix(toolSlug, knownSlugs);
    if (match !== undefined) {
      // Bare `composio`-prefixed slugs are meta tools, not user-linkable
      // toolkits. This is a resolved answer, not a miss: without it every
      // `COMPOSIO_*` tool would fall through to a catalog fetch.
      return match === 'composio' ? undefined : match;
    }

    const repository = yield* ComposioToolkitsRepository;
    const toolkits = yield* repository.getToolkits();
    const fetchedSlugs = toolkits.map(toolkit => toolkit.slug);

    yield* Effect.forkDaemon(writeKnownToolkitSlugs([...knownSlugs, ...fetchedSlugs]));

    return matchToolkitFromToolSlug(toolSlug, [...knownSlugs, ...fetchedSlugs]);
  }).pipe(Effect.catchAll(() => Effect.succeed(guessToolkitFromToolSlug(toolSlug))));
