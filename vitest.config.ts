import { configDefaults, defineConfig } from "vitest/config";

// Docker tests (`*.docker.test.ts`) run only through `pnpm test:docker` (DOCKER_TESTS) and tests against real network
// services (`*.integration.test.ts`) only through `pnpm test:integration` (INTEGRATION_TESTS), so the git hooks stay
// fast and work offline.
const docker = process.env.DOCKER_TESTS === "1";
const integration = process.env.INTEGRATION_TESTS === "1";
const special = ["src/**/*.docker.test.ts", "src/**/*.integration.test.ts"];

const include = () => {
  if (docker) {
    return ["src/**/*.docker.test.ts"];
  }
  if (integration) {
    return ["src/**/*.integration.test.ts"];
  }
  return ["src/**/*.test.ts"];
};

export default defineConfig({
  test: {
    include: include(),
    exclude:
      docker || integration
        ? configDefaults.exclude
        : [...configDefaults.exclude, ...special],
  },
});
