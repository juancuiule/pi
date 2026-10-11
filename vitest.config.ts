import { configDefaults, defineConfig } from "vitest/config";

// Docker integration tests (`*.docker.test.ts`) only run through `pnpm test:docker`, which sets DOCKER_TESTS,
// so the git hooks stay fast and work without Docker.
const docker = process.env.DOCKER_TESTS === "1";

export default defineConfig({
  test: {
    include: docker ? ["src/**/*.docker.test.ts"] : ["src/**/*.test.ts"],
    exclude: docker
      ? configDefaults.exclude
      : [...configDefaults.exclude, "src/**/*.docker.test.ts"],
  },
});
