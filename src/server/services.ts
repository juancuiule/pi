// The `services` group: which Services the caller may open, and the edge's forward_auth check before each request to
// one (deploy/Caddyfile). The session itself is `Authentication`'s, like every group's; this adds which Services this
// server serves (EDGE_SERVICES) and which accounts may open them (SERVICE_USERS, else the oldest account). Every
// Service shows every User's data (traces, buckets), so it is not for every account.
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Auth } from "../auth/auth.ts";
import { ServiceForbidden, ServiceNotFound } from "../errors.ts";
import type { ServiceName } from "../services.ts";
import { isServiceName, mayOpenServices, SERVICES } from "../services.ts";
import { Api, CurrentUser } from "./api.ts";

export interface ServicesOptions {
  /** The Services the edge serves (EDGE_SERVICES); unset, none. */
  readonly enabled?: readonly ServiceName[] | undefined;
  /** The accounts that may open them (SERVICE_USERS); unset or empty, the oldest account only. */
  readonly users?: readonly string[] | undefined;
}

const serviceOf = (name: ServiceName) => ({ name, ...SERVICES[name] });

export const servicesHandlers = (options: ServicesOptions = {}) =>
  HttpApiBuilder.group(
    Api,
    "services",
    Effect.fnUntraced(function* (handlers) {
      const auth = yield* Auth;
      const enabled = options.enabled ?? [];
      const allowed = Effect.gen(function* () {
        const user = yield* CurrentUser;
        const [oldest] = yield* auth.users;
        return mayOpenServices(user, { users: options.users, oldest });
      });
      return handlers
        .handle("list", () =>
          allowed.pipe(
            Effect.map((may) =>
              may ? enabled.map((name) => serviceOf(name)) : []
            )
          )
        )
        .handle("get", ({ params: { name } }) =>
          Effect.gen(function* () {
            if (!isServiceName(name) || !enabled.includes(name)) {
              return yield* new ServiceNotFound({ name });
            }
            if (!(yield* allowed)) {
              return yield* new ServiceForbidden({ name });
            }
            return serviceOf(name);
          })
        );
    })
  );
