import { describe, expect, it } from '@effect/vitest';
import { FileSystem } from '@effect/platform';
import { BunFileSystem } from '@effect/platform-bun';
import { ConfigProvider, DateTime, Effect, Layer, Schedule } from 'effect';
import * as tempy from 'tempy';
import { toolkitFromToolSlug } from 'src/effects/toolkit-from-tool-slug';
import type { Toolkit, Toolkits } from 'src/models/toolkits';
import { ComposioToolkitsRepository, HttpServerError } from 'src/services/composio-clients';
import { KNOWN_TOOLKIT_SLUGS_FILE } from 'src/services/known-toolkit-slugs';
import {
  countingToolkitsRepository,
  type GetToolkitsError,
} from 'test/__utils__/services/toolkits-repository-stub';

const makeToolkit = (slug: string): Toolkit => ({
  name: slug,
  slug,
  auth_schemes: ['OAUTH2'],
  composio_managed_auth_schemes: ['OAUTH2'],
  is_local_toolkit: false,
  no_auth: false,
  meta: {
    description: `${slug} toolkit`,
    categories: [],
    created_at: DateTime.unsafeMake('2024-05-03T11:44:32.061Z'),
    updated_at: DateTime.unsafeMake('2024-05-03T11:44:32.061Z'),
    available_versions: [],
    tools_count: 0,
    triggers_count: 0,
  },
});

/**
 * A toolkit that cannot be in the baked catalog, standing in for one released
 * after the binary was built. Tests of the fetch path must use slugs like this
 * — anything real resolves locally and never reaches the repository.
 */
const UNRELEASED_TOOLKIT = 'acme_analytics';

const failingFetch = () =>
  Effect.fail(new HttpServerError({ cause: 'catalog unavailable', status: 503 }));

/**
 * A learned-slugs file recorded `daysAgo` days ago. Anything under a week old
 * keeps the resolver from starting a background refresh, which is what makes
 * "no catalog fetch" assertions meaningful.
 */
const learnedFileContent = (slugs: ReadonlyArray<string>, daysAgo = 0) =>
  JSON.stringify({
    slugs,
    refreshedAt: DateTime.formatIso(DateTime.subtract(DateTime.unsafeNow(), { days: daysAgo })),
  });

interface ResolverContext {
  readonly calls: () => number;
  readonly waitForLearnedFile: (
    predicate: (content: string) => boolean
  ) => Effect.Effect<string, unknown, FileSystem.FileSystem>;
}

/**
 * Runs `program` against a private cache directory, so the resolver reads and
 * writes a learned-slugs file belonging to this test alone. `seedLearnedFile`
 * is written verbatim — including deliberately corrupt content.
 */
const withResolver = <A>(
  options: {
    readonly getToolkits?: () => Effect.Effect<Toolkits, GetToolkitsError>;
    readonly seedLearnedFile?: string;
  },
  program: (
    context: ResolverContext
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | ComposioToolkitsRepository>
) =>
  Effect.suspend(() => {
    const cacheDir = tempy.temporaryDirectory();
    return runInCacheDir(cacheDir, options, program);
  });

const runInCacheDir = <A>(
  cacheDir: string,
  options: {
    readonly getToolkits?: () => Effect.Effect<Toolkits, GetToolkitsError>;
    readonly seedLearnedFile?: string;
  },
  program: (
    context: ResolverContext
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | ComposioToolkitsRepository>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const learnedFile = `${cacheDir}/${KNOWN_TOOLKIT_SLUGS_FILE}`;

    if (options.seedLearnedFile !== undefined) {
      yield* fs.writeFileString(learnedFile, options.seedLearnedFile);
    }

    const repository = countingToolkitsRepository(
      options.getToolkits ?? (() => Effect.succeed([] as Toolkits))
    );

    const readLearnedFile = fs.readFileString(learnedFile);

    return yield* program({
      calls: repository.calls,
      // The resolver records what it learns in the background, so a test that
      // asserts on the file has to wait for it rather than read once.
      waitForLearnedFile: predicate =>
        readLearnedFile.pipe(
          Effect.filterOrFail(predicate, () => 'learned file has not caught up yet' as const),
          Effect.retry(Schedule.spaced('10 millis').pipe(Schedule.intersect(Schedule.recurs(200))))
        ),
    }).pipe(Effect.provide(repository.layer));
  }).pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['CACHE_DIR', cacheDir]])))
  );

describe('toolkitFromToolSlug', () => {
  it.effect('resolves a baked multi-word toolkit without touching the network', () =>
    withResolver({ seedLearnedFile: learnedFileContent([]) }, ({ calls }) =>
      Effect.gen(function* () {
        expect(yield* toolkitFromToolSlug('GOOGLE_ANALYTICS_RUN_REPORT')).toBe('google_analytics');
        expect(yield* toolkitFromToolSlug('GMAIL_SEND_EMAIL')).toBe('gmail');
        expect(calls()).toBe(0);
      })
    )
  );

  it.effect('gives meta tools no toolkit, even when one shadows their slug', () =>
    withResolver({ seedLearnedFile: learnedFileContent([]) }, ({ calls }) =>
      Effect.gen(function* () {
        // `composio_search` is a real, linkable toolkit whose slug is a prefix
        // of this session meta tool. Attributing the meta tool to it would
        // send users to link an app they do not need.
        expect(yield* toolkitFromToolSlug('COMPOSIO_SEARCH_TOOLS')).toBeUndefined();
        expect(yield* toolkitFromToolSlug('COMPOSIO_MANAGE_CONNECTIONS')).toBeUndefined();
        expect(calls()).toBe(0);
      })
    )
  );

  it.effect('treats a bare `composio` match as resolved, not as a miss', () =>
    withResolver({ seedLearnedFile: learnedFileContent([]) }, ({ calls }) =>
      Effect.gen(function* () {
        expect(yield* toolkitFromToolSlug('COMPOSIO_ENABLE_TRIGGER')).toBeUndefined();
        // A miss here would cost every `COMPOSIO_*` tool a catalog fetch.
        expect(calls()).toBe(0);
      })
    )
  );

  it.live('answers from the baked list on a first run, and seeds the file behind it', () =>
    withResolver(
      { getToolkits: () => Effect.succeed([makeToolkit(UNRELEASED_TOOLKIT)]) },
      ({ waitForLearnedFile }) =>
        Effect.gen(function* () {
          expect(yield* toolkitFromToolSlug('GOOGLE_ANALYTICS_RUN_REPORT')).toBe(
            'google_analytics'
          );

          const learned = yield* waitForLearnedFile(content =>
            content.includes(UNRELEASED_TOOLKIT)
          );
          expect(learned).toContain('google_analytics');
        })
    )
  );

  it.live('resolves a learned toolkit without touching the network', () =>
    withResolver(
      {
        seedLearnedFile: learnedFileContent([UNRELEASED_TOOLKIT]),
      },
      ({ calls }) =>
        Effect.gen(function* () {
          expect(yield* toolkitFromToolSlug('ACME_ANALYTICS_RUN_REPORT')).toBe(UNRELEASED_TOOLKIT);
          expect(calls()).toBe(0);
        })
    )
  );

  it.live('fetches the catalog for an unknown slug, and remembers what it finds', () =>
    withResolver(
      {
        getToolkits: () => Effect.succeed([makeToolkit(UNRELEASED_TOOLKIT)]),
        seedLearnedFile: learnedFileContent([]),
      },
      ({ calls, waitForLearnedFile }) =>
        Effect.gen(function* () {
          expect(yield* toolkitFromToolSlug('ACME_ANALYTICS_RUN_REPORT')).toBe(UNRELEASED_TOOLKIT);
          expect(calls()).toBe(1);

          const learned = yield* waitForLearnedFile(content =>
            content.includes(UNRELEASED_TOOLKIT)
          );
          // Baked slugs are recorded alongside it, so the file stands alone.
          expect(learned).toContain('google_analytics');
        })
    )
  );

  it.live('falls back to the first-underscore guess when the catalog is unreachable', () =>
    withResolver(
      {
        getToolkits: failingFetch,
        seedLearnedFile: learnedFileContent([]),
      },
      ({ calls }) =>
        Effect.gen(function* () {
          expect(yield* toolkitFromToolSlug('ACME_ANALYTICS_RUN_REPORT')).toBe('acme');
          expect(calls()).toBe(1);
        })
    )
  );

  it.live('tolerates a corrupted learned-slugs file', () =>
    withResolver({ seedLearnedFile: '{ not json' }, ({ calls }) =>
      Effect.gen(function* () {
        expect(yield* toolkitFromToolSlug('GOOGLE_ANALYTICS_RUN_REPORT')).toBe('google_analytics');
        expect(calls()).toBeLessThanOrEqual(1);
      })
    )
  );

  it.live('refreshes learned slugs in the background once they go stale', () =>
    withResolver(
      {
        getToolkits: () => Effect.succeed([makeToolkit(UNRELEASED_TOOLKIT)]),
        seedLearnedFile: learnedFileContent(['stale_toolkit'], 8),
      },
      ({ waitForLearnedFile }) =>
        Effect.gen(function* () {
          // Answered from the baked list — the refresh is what the fetch is for.
          expect(yield* toolkitFromToolSlug('GOOGLE_ANALYTICS_RUN_REPORT')).toBe(
            'google_analytics'
          );

          const learned = yield* waitForLearnedFile(content =>
            content.includes(UNRELEASED_TOOLKIT)
          );
          expect(learned).not.toContain('stale_toolkit');
        })
    )
  );

  it.live('does not refresh while the learned slugs are fresh', () =>
    withResolver(
      {
        getToolkits: failingFetch,
        seedLearnedFile: learnedFileContent([UNRELEASED_TOOLKIT], 6),
      },
      ({ calls }) =>
        Effect.gen(function* () {
          expect(yield* toolkitFromToolSlug('ACME_ANALYTICS_RUN_REPORT')).toBe(UNRELEASED_TOOLKIT);
          yield* Effect.sleep('50 millis');
          expect(calls()).toBe(0);
        })
    )
  );
});
