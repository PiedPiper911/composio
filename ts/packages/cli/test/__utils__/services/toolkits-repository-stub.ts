import { Effect, Layer } from 'effect';
import { ComposioToolkitsRepository } from 'src/services/composio-clients';
import type { Toolkits } from 'src/models/toolkits';

export type GetToolkitsError = Effect.Effect.Error<
  ReturnType<ComposioToolkitsRepository['getToolkits']>
>;

/**
 * Every repository method the toolkit-catalog suites do not exercise. A call
 * to any of them is a defect in the test, not a scenario to handle.
 */
const unusedRepositoryMethods = {
  getToolkitsBySlugs: () => Effect.die('getToolkitsBySlugs is not used in this test'),
  getMetrics: () => Effect.die('getMetrics is not used in this test'),
  getToolsAsEnums: () => Effect.die('getToolsAsEnums is not used in this test'),
  getTools: () => Effect.die('getTools is not used in this test'),
  getToolsByVersionSpecs: () => Effect.die('getToolsByVersionSpecs is not used in this test'),
  getTriggerTypesAsEnums: () => Effect.die('getTriggerTypesAsEnums is not used in this test'),
  getTriggerTypes: () => Effect.die('getTriggerTypes is not used in this test'),
  getTriggerTypeDetailed: () => Effect.die('getTriggerTypeDetailed is not used in this test'),
  validateToolkits: () => Effect.die('validateToolkits is not used in this test'),
  validateToolkitVersions: () => Effect.die('validateToolkitVersions is not used in this test'),
  filterToolkitsBySlugs: () => [],
  searchToolkits: () => Effect.die('searchToolkits is not used in this test'),
  getToolkitDetailed: () => Effect.die('getToolkitDetailed is not used in this test'),
  searchTools: () => Effect.die('searchTools is not used in this test'),
  getToolDetailed: () => Effect.die('getToolDetailed is not used in this test'),
  listAuthConfigs: () => Effect.die('listAuthConfigs is not used in this test'),
  getAuthConfig: () => Effect.die('getAuthConfig is not used in this test'),
  createAuthConfig: () => Effect.die('createAuthConfig is not used in this test'),
  deleteAuthConfig: () => Effect.die('deleteAuthConfig is not used in this test'),
  listConnectedAccounts: () => Effect.die('listConnectedAccounts is not used in this test'),
  getConnectedAccount: () => Effect.die('getConnectedAccount is not used in this test'),
  deleteConnectedAccount: () => Effect.die('deleteConnectedAccount is not used in this test'),
  createConnectedAccountLink: () =>
    Effect.die('createConnectedAccountLink is not used in this test'),
  listActiveTriggers: () => Effect.die('listActiveTriggers is not used in this test'),
  createTrigger: () => Effect.die('createTrigger is not used in this test'),
  enableTrigger: () => Effect.die('enableTrigger is not used in this test'),
  disableTrigger: () => Effect.die('disableTrigger is not used in this test'),
  deleteTrigger: () => Effect.die('deleteTrigger is not used in this test'),
} as const;

/**
 * A `ComposioToolkitsRepository` layer that counts catalog fetches, so a test
 * can assert not just what was resolved but what it cost.
 */
export const countingToolkitsRepository = (
  getToolkits: () => Effect.Effect<Toolkits, GetToolkitsError>
) => {
  let calls = 0;

  const layer = Layer.succeed(
    ComposioToolkitsRepository,
    new ComposioToolkitsRepository({
      ...unusedRepositoryMethods,
      getToolkits: () =>
        Effect.suspend(() => {
          calls += 1;
          return getToolkits();
        }),
    })
  );

  return { layer, calls: () => calls };
};
