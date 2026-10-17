import { configDefaults, defineConfig } from "vitest/config";

// Docker tests (`*.docker.test.ts`) run only through `pnpm test:docker` (DOCKER_TESTS), tests against real
// network services (`*.integration.test.ts`) only through `pnpm test:integration` (INTEGRATION_TESTS), and
// tests against the real S3 store (`*.s3.test.ts`) only through `pnpm test:s3` (S3_TESTS), so the git hooks
// stay fast and work offline.
const docker = process.env.DOCKER_TESTS === "1";
const integration = process.env.INTEGRATION_TESTS === "1";
const s3 = process.env.S3_TESTS === "1";
const special = [
  "src/**/*.docker.test.ts",
  "src/**/*.integration.test.ts",
  "src/**/*.s3.test.ts",
];

const include = () => {
  if (docker) {
    return ["src/**/*.docker.test.ts"];
  }
  if (integration) {
    return ["src/**/*.integration.test.ts"];
  }
  if (s3) {
    return ["src/**/*.s3.test.ts"];
  }
  return ["src/**/*.test.ts"];
};

export default defineConfig({
  test: {
    include: include(),
    exclude:
      docker || integration || s3
        ? configDefaults.exclude
        : [...configDefaults.exclude, ...special],
  },
});
